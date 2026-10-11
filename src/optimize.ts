import {
  mkdir,
  lstat,
  readFile,
  unlink,
  readdir,
  open,
  realpath,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Engine, type FileInfo } from "./engine.js";
import { exists, moduleRoots } from "./project.js";
import {
  atomicJson,
  contentHash,
  externalCandidates,
  home,
  projectKey,
  walkFiles,
  type StoreLocation,
} from "./store.js";

export interface Options {
  dryRun: boolean;
  min: number;
  location: StoreLocation;
}
export interface Report {
  project: string;
  provider: string;
  format: string;
  dryRun: boolean;
  scannedFiles: number;
  eligibleFiles: number;
  seededFiles: number;
  clonedFiles: number;
  sharedLogicalBytes: number;
  externalHits: number;
  alreadyOptimized: number;
  skippedFiles: number;
  errors: string[];
  privateBytesBefore: number | null;
  privateBytesAfter: number | null;
  volumeAvailableBefore: number;
  volumeAvailableAfter: number;
}
export async function withProjectLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  const folder = join(home(), "locks");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, projectKey(root));
  try {
    await mkdir(path);
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const owner = JSON.parse(
      await readFile(join(path, "owner.json"), "utf8").catch(() => '{"pid":0}'),
    );
    if (owner.pid) {
      try {
        process.kill(owner.pid, 0);
        throw new Error(
          "Another DepWeave operation is active for this project.",
        );
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
      }
    } else
      throw new Error(
        `Project lock is incomplete: ${path}. Remove it only after checking no operation is active.`,
      );
    await unlink(join(path, "owner.json")).catch(() => {});
    const { rmdir } = await import("node:fs/promises");
    await rmdir(path);
    await mkdir(path);
  }
  await atomicJson(join(path, "owner.json"), { pid: process.pid, root });
  try {
    return await work();
  } finally {
    await unlink(join(path, "owner.json")).catch(() => {});
    const { rmdir } = await import("node:fs/promises");
    await rmdir(path).catch(() => {});
  }
}
async function durableJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
}
async function recover(root: string, journalDir: string): Promise<void> {
  for (const name of await readdir(journalDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(journalDir, name);
    const record = JSON.parse(await readFile(path, "utf8"));
    const target = resolve(record.target),
      temp = resolve(record.temp);
    if (
      !target.startsWith(root + "/") ||
      dirname(temp) !== dirname(target) ||
      !temp.split("/").at(-1)!.startsWith(".depweave-")
    )
      throw new Error(`Invalid recovery journal: ${path}`);
    if (await exists(temp)) {
      if (
        !(await exists(target)) ||
        (await contentHash(target)) !== record.hash ||
        (await contentHash(temp)) !== record.hash
      ) {
        throw new Error(
          `Recovery needs manual inspection; original data retained at ${temp}`,
        );
      }
      await unlink(temp);
    }
    await unlink(path);
  }
}

export async function optimize(
  root: string,
  options: Options,
  engine: Engine,
): Promise<Report> {
  root = await realpath(root);
  const volume = await engine.request<{
    apfs: boolean;
    availableBytes: number;
  }>({ op: "volume", path: root });
  if (!volume.apfs)
    throw new Error(
      "Optimization requires macOS APFS; no copy or hardlink fallback is performed.",
    );
  const roots = await moduleRoots(root);
  const files = (
    await Promise.all(roots.map((p) => walkFiles(p, true)))
  ).flat();
  const report: Report = {
    project: root,
    provider: options.location.provider,
    format: options.location.format,
    dryRun: options.dryRun,
    scannedFiles: files.length,
    eligibleFiles: 0,
    seededFiles: 0,
    clonedFiles: 0,
    sharedLogicalBytes: 0,
    externalHits: 0,
    alreadyOptimized: 0,
    skippedFiles: 0,
    errors: [],
    privateBytesBefore: 0,
    privateBytesAfter: 0,
    volumeAvailableBefore: volume.availableBytes,
    volumeAvailableAfter: volume.availableBytes,
  };
  const stateDir = join(home(), "projects", projectKey(root));
  const objectDir = join(
    home(),
    "stores",
    String((await lstat(root)).dev),
    "objects",
  );
  const journalDir = join(stateDir, "journal");
  let previous: Record<string, { signature: string; hash: string }> = {};
  if (await exists(join(stateDir, "files.json")))
    previous = JSON.parse(await readFile(join(stateDir, "files.json"), "utf8"));
  if (!options.dryRun) {
    await mkdir(objectDir, { recursive: true, mode: 0o700 });
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    if ((await lstat(objectDir)).dev !== (await lstat(root)).dev)
      throw new Error(
        "DEPWEAVE_HOME must be on the same filesystem as this project.",
      );
    await recover(root, journalDir);
  }
  const eligible: Array<{ path: string; info: FileInfo }> = [];
  for (const path of files) {
    const stat = await lstat(path);
    if (stat.size < options.min || stat.nlink !== 1 || stat.mode & 0o7000) {
      report.skippedFiles++;
      continue;
    }
    const info = await engine.info(path);
    if (info.flags) {
      report.skippedFiles++;
      continue;
    }
    eligible.push({ path, info });
    if (info.privateBytes === null) report.privateBytesBefore = null;
    else if (report.privateBytesBefore !== null)
      report.privateBytesBefore += info.privateBytes;
  }
  report.eligibleFiles = eligible.length;
  const external = await externalCandidates(
    options.location,
    new Set(eligible.map((f) => f.info.size)),
    options.min,
  );
  const next: typeof previous = { ...previous };
  const dryCandidates = new Map<string, string>();
  for (const { path, info } of eligible) {
    try {
      const hash = await contentHash(path),
        key = `${hash}:${info.size}`;
      if (
        previous[path]?.signature === info.signature &&
        previous[path]?.hash === hash
      ) {
        report.alreadyOptimized++;
        continue;
      }
      const object = join(objectDir, hash.slice(0, 2), hash.slice(2));
      const candidate =
        external.get(key) ??
        ((await exists(object)) ? object : dryCandidates.get(key));
      if (candidate && candidate !== path) {
        if ((await lstat(candidate)).dev !== (await lstat(path)).dev) {
          report.skippedFiles++;
          continue;
        }
        if ((await contentHash(candidate)) !== hash)
          throw new Error(
            "Candidate content mismatch; source store is unchanged.",
          );
        if (external.has(key)) report.externalHits++;
        if (!options.dryRun) {
          const id = randomUUID(),
            temp = join(dirname(path), `.depweave-${id}`),
            journal = join(journalDir, id + ".json");
          await durableJson(journal, { target: path, temp, hash });
          const after = await engine.request<FileInfo>({
            op: "replace",
            source: candidate,
            target: path,
            temp,
            hash,
            signature: info.signature,
          });
          next[path] = { signature: after.signature, hash };
          await unlink(journal);
        }
        report.clonedFiles++;
        report.sharedLogicalBytes += info.size;
      } else if (!options.dryRun) {
        await mkdir(dirname(object), { recursive: true, mode: 0o700 });
        const temp = object + `.${randomUUID()}.tmp`;
        try {
          await engine.request({
            op: "clone",
            source: path,
            target: temp,
            hash,
            readonly: true,
          });
          const { rename } = await import("node:fs/promises");
          await rename(temp, object);
        } finally {
          await unlink(temp).catch(() => {});
        }
        next[path] = { signature: (await engine.info(path)).signature, hash };
        report.seededFiles++;
      } else {
        dryCandidates.set(key, path);
        report.seededFiles++;
      }
    } catch (error: any) {
      report.errors.push(`${path}: ${error.message}`);
    }
  }
  if (!options.dryRun) await atomicJson(join(stateDir, "files.json"), next);
  for (const { path } of eligible) {
    const info = await engine.info(path);
    if (info.privateBytes === null) report.privateBytesAfter = null;
    else if (report.privateBytesAfter !== null)
      report.privateBytesAfter += info.privateBytes;
  }
  report.volumeAvailableAfter = (
    await engine.request({ op: "volume", path: root })
  ).availableBytes;
  return report;
}
