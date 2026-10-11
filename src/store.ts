import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  mkdir,
  rename,
  writeFile,
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { exists } from "./project.js";

const exec = promisify(execFile);
export type Provider = "own" | "pnpm" | "yarn";
export interface Settings {
  schemaVersion: number;
  store: { provider: Provider; path?: string };
  projects: Record<string, { provider: Provider; path?: string }>;
}
export function home(): string {
  const path = resolve(
    process.env.DEPWEAVE_HOME ??
      join(homedir(), "Library", "Application Support", "DepWeave"),
  );
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor)
    ancestor = dirname(ancestor);
  return join(realpathSync(ancestor), relative(ancestor, path));
}
export function projectKey(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}
export async function settings(): Promise<Settings> {
  const path = join(home(), "config.json");
  if (!(await exists(path)))
    return { schemaVersion: 1, store: { provider: "own" }, projects: {} };
  const data = JSON.parse(await readFile(path, "utf8"));
  if (
    data.schemaVersion !== 1 ||
    !["own", "pnpm", "yarn"].includes(data.store?.provider)
  )
    throw new Error("Unsupported DepWeave configuration.");
  return { ...data, projects: data.projects ?? {} };
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

export async function walkFiles(
  root: string,
  skipHidden = false,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        (skipHidden && (entry.name.startsWith(".") || entry.name === ".cache"))
      )
        continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Store and scan roots must not be symlinks.");
  await visit(root);
  return files;
}
export async function contentHash(path: string): Promise<string> {
  const { open, constants } = await import("node:fs/promises");
  // Native engine reopens every candidate with no-follow-any before use.
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const digest = createHash("sha256");
    for await (const chunk of fd.createReadStream({ autoClose: false }))
      digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await fd.close();
  }
}
export interface StoreLocation {
  provider: Provider;
  external?: string;
  format: string;
}
export async function discoverStore(
  provider: Provider,
  explicit: string | undefined,
  cwd: string,
): Promise<StoreLocation> {
  if (!["own", "pnpm", "yarn"].includes(provider))
    throw new Error("Unknown storage provider in configuration.");
  if (provider === "own") return { provider, format: "depweave-sha256-v1" };
  let root = explicit;
  if (!root && provider === "pnpm")
    root = (await exec("pnpm", ["store", "path"], { cwd })).stdout.trim();
  if (!root && provider === "yarn") {
    const globalFolder = (
      await exec("yarn", ["config", "get", "globalFolder"], { cwd })
    ).stdout.trim();
    if (!globalFolder || globalFolder === "undefined")
      throw new Error(
        "Modern Yarn is needed to discover its store; supply --store-path explicitly.",
      );
    root = join(globalFolder.replace(/^"|"$/g, ""), "store", "v1");
  }
  root = await realpath(resolve(root!));
  if (provider === "pnpm") {
    if (!/\/v10$/.test(root) || !(await exists(join(root, "files"))))
      throw new Error(
        "pnpm adapter supports the pnpm 10 v10/files layout only; choose its active store path.",
      );
    return {
      provider,
      external: join(root, "files"),
      format: "pnpm-v10-files",
    };
  }
  if (!/\/v1$/.test(root)) {
    if (await exists(join(root, "store", "v1")))
      root = join(root, "store", "v1");
    else if (await exists(join(root, "v1"))) root = join(root, "v1");
    else
      throw new Error(
        "Yarn adapter requires its unpacked global store/v1, not the zip cache.",
      );
  }
  return { provider, external: root, format: "yarn-global-store-v1-preview" };
}

export async function externalCandidates(
  location: StoreLocation,
  sizes: Set<number>,
  min: number,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  if (!location.external) return index;
  for (const file of await walkFiles(location.external)) {
    // pnpm index manifests reside next to data files. Do not treat them as
    // package content. Every data candidate is independently hashed anyway.
    if (location.provider === "pnpm" && file.endsWith("-index.json")) continue;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size < min || !sizes.has(stat.size)) continue;
    index.set(`${await contentHash(file)}:${stat.size}`, file);
  }
  return index;
}
