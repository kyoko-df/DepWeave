import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  readlink,
  lstat,
  statfs,
  realpath,
  chmod,
  open,
} from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Engine } from "../dist/engine.js";
import { contentHash } from "../dist/store.js";

const repository = resolve(".");
const volume = await realpath(
  process.env.DEPWEAVE_VALIDATION_ROOT ?? join(repository, ".work", "volume"),
);
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 6);
const root = join(volume, runId),
  output = join(repository, ".work", "validation", runId);
await mkdir(root, { recursive: true });
await mkdir(output, { recursive: true });
const env = { ...process.env, DEPWEAVE_HOME: join(root, "state") };
const cli = join(repository, "bin", "depweave.mjs");
const commands = [];
async function run(command, args, cwd) {
  const start = performance.now();
  let stdout = "",
    stderr = "";
  const code = await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("exit", accept);
  });
  commands.push({
    command,
    args,
    cwd,
    code,
    durationMs: Math.round(performance.now() - start),
  });
  await writeFile(
    join(output, `command-${commands.length}.log`),
    stdout + stderr,
  );
  assert.equal(
    code,
    0,
    `${command} ${args.join(" ")} failed:\n${stdout}\n${stderr}`,
  );
  return stdout;
}
async function fixture(name, manager) {
  const path = join(root, name);
  await mkdir(join(path, "scripts"), { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify(
      {
        name: "depweave-validation",
        version: "1.0.0",
        private: true,
        packageManager: manager === "npm" ? "npm@10.9.3" : "yarn@1.22.19",
        dependencies: { typescript: "5.9.3", lodash: "4.17.21" },
        scripts: { postinstall: "node scripts/postinstall.cjs" },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(path, "scripts", "postinstall.cjs"),
    `require('node:fs').writeFileSync('.postinstall.json', JSON.stringify({cwd:process.cwd(),agent:process.env.npm_config_user_agent,sum:require('lodash').sum([1,2,3])}));\n`,
  );
  return path;
}
async function snapshot(directory, timestamps = false) {
  const result = {};
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name),
        key = relative(directory, path),
        stat = await lstat(path, { bigint: true });
      if (entry.isSymbolicLink()) result[key] = { link: await readlink(path) };
      else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        result[key] = {
          hash: await contentHash(path),
          mode: Number(stat.mode & 0o7777n),
          ...(timestamps
            ? {
                mtime: String(stat.mtimeNs),
                birthtime: String(stat.birthtimeNs),
              }
            : {}),
        };
    }
  }
  await visit(directory);
  return result;
}
async function available() {
  await run("/bin/sync", [], repository);
  const fs = await statfs(volume, { bigint: true });
  return Number(fs.bavail * fs.bsize);
}
async function optimize(project) {
  const raw = await run(
    process.execPath,
    [cli, "optimize", "--cwd", project, "--json"],
    repository,
  );
  const result = JSON.parse(raw);
  assert.equal(result.errors.length, 0, result.errors.join("\n"));
  return result;
}

console.log(
  "Installing two npm and two Yarn Classic projects on the validation filesystem…",
);
const npmDirect = await fixture("npm-direct", "npm"),
  npmWrapped = await fixture("npm-wrapped", "npm");
const yarnDirect = await fixture("yarn-direct", "yarn"),
  yarnWrapped = await fixture("yarn-wrapped", "yarn");
const npmArgs = ["--cache", join(root, "npm-cache"), "--no-audit", "--no-fund"];
const yarnArgs = [
  "--cache-folder",
  join(root, "yarn-cache"),
  "--non-interactive",
];
await run("npm", ["install", ...npmArgs], npmDirect);
await run(
  process.execPath,
  [cli, "install", "--cwd", npmWrapped, "--no-optimize", "--", ...npmArgs],
  repository,
);
await run("yarn", ["install", ...yarnArgs], yarnDirect);
await run(
  process.execPath,
  [cli, "install", "--cwd", yarnWrapped, "--no-optimize", "--", ...yarnArgs],
  repository,
);
assert.deepEqual(
  await snapshot(join(npmDirect, "node_modules")),
  await snapshot(join(npmWrapped, "node_modules")),
);
assert.deepEqual(
  await snapshot(join(yarnDirect, "node_modules")),
  await snapshot(join(yarnWrapped, "node_modules")),
);
assert.equal(
  await readFile(join(npmDirect, "package-lock.json"), "utf8"),
  await readFile(join(npmWrapped, "package-lock.json"), "utf8"),
);
assert.equal(
  await readFile(join(yarnDirect, "yarn.lock"), "utf8"),
  await readFile(join(yarnWrapped, "yarn.lock"), "utf8"),
);
for (const [project, manager] of [
  [npmWrapped, "npm"],
  [yarnWrapped, "yarn"],
]) {
  const marker = JSON.parse(
    await readFile(join(project, ".postinstall.json"), "utf8"),
  );
  assert.equal(marker.cwd, project);
  assert.equal(marker.sum, 6);
  assert.ok(marker.agent.startsWith(manager + "/"));
}

const before = await available(),
  reports = [];
for (const project of [npmDirect, npmWrapped, yarnDirect, yarnWrapped]) {
  const contents = await snapshot(join(project, "node_modules"), true);
  const manifest = await readFile(join(project, "package.json"), "utf8");
  const lockName = project.includes("npm-") ? "package-lock.json" : "yarn.lock";
  const lock = await readFile(join(project, lockName), "utf8");
  reports.push(await optimize(project));
  assert.deepEqual(
    await snapshot(join(project, "node_modules"), true),
    contents,
  );
  assert.equal(await readFile(join(project, "package.json"), "utf8"), manifest);
  assert.equal(await readFile(join(project, lockName), "utf8"), lock);
}
const after = await available(),
  reclaimed = after - before;
assert.ok(
  reclaimed > 8 * 1024 * 1024,
  `Expected measurable reclamation on isolated APFS volume; saw ${reclaimed} bytes.`,
);
console.log(
  `Measured ${Math.round(reclaimed / 1048576)} MiB of additional free space after optimization.`,
);

const engine = new Engine();
let cloneEvidence;
try {
  const a = join(
      npmDirect,
      "node_modules",
      "typescript",
      "lib",
      "typescript.js",
    ),
    b = join(npmWrapped, "node_modules", "typescript", "lib", "typescript.js");
  const ai = await engine.info(a),
    bi = await engine.info(b);
  assert.notEqual(ai.inode, bi.inode);
  assert.equal(ai.cloneId, bi.cloneId);
  assert.notEqual(ai.cloneId, "0");
  const beforeA = await contentHash(a),
    beforeB = await contentHash(b);
  await chmod(b, 0o644);
  const fd = await open(b, "r+");
  await fd.write(Buffer.from("//changed"), 0, 9, 0);
  await fd.close();
  assert.equal(await contentHash(a), beforeA);
  assert.notEqual(await contentHash(b), beforeB);
  cloneEvidence = {
    before: { a: ai, b: bi },
    afterMutation: { a: await engine.info(a), b: await engine.info(b) },
    isolatedWrites: true,
  };
} finally {
  await engine.close();
}

console.log(
  "Checking combined install + optimization and subsequent native dependency changes…",
);
const combined = await fixture("npm-combined", "npm");
const combinedOutput = await run(
  process.execPath,
  [
    cli,
    "install",
    "--cwd",
    combined,
    "--require-optimize",
    "--json",
    "--",
    ...npmArgs,
  ],
  repository,
);
const combinedReport = JSON.parse(combinedOutput);
assert.ok(combinedReport.clonedFiles > 0);
assert.equal(combinedReport.errors.length, 0);
await run("npm", ["install", "minimist@1.2.8", ...npmArgs], combined);
assert.equal(
  JSON.parse(await readFile(join(combined, "package.json"), "utf8"))
    .dependencies.minimist,
  "^1.2.8",
);
await run(
  process.execPath,
  [
    cli,
    "remove",
    "minimist",
    "--cwd",
    combined,
    "--require-optimize",
    "--",
    ...npmArgs,
  ],
  repository,
);
assert.equal(
  JSON.parse(await readFile(join(combined, "package.json"), "utf8"))
    .dependencies.minimist,
  undefined,
);
await run("yarn", ["add", "minimist@1.2.8", ...yarnArgs], yarnWrapped);
await run(
  process.execPath,
  [
    cli,
    "remove",
    "minimist",
    "--cwd",
    yarnWrapped,
    "--require-optimize",
    "--",
    ...yarnArgs,
  ],
  repository,
);
assert.equal(
  JSON.parse(await readFile(join(yarnWrapped, "package.json"), "utf8"))
    .dependencies.minimist,
  undefined,
);
await run(
  process.execPath,
  [
    "-e",
    "if(require('lodash').sum([1,2,3])!==6)process.exit(1);console.log(require('typescript').version)",
  ],
  combined,
);
await run(
  process.execPath,
  [
    "-e",
    "if(require('lodash').sum([1,2,3])!==6)process.exit(1);console.log(require('typescript').version)",
  ],
  yarnWrapped,
);

const result = {
  date: new Date().toISOString(),
  runId,
  filesystem: "APFS isolated sparse-image volume",
  root,
  versions: {
    node: process.version,
    npm: (await run("npm", ["--version"], repository)).trim(),
    yarn: (await run("yarn", ["--version"], repository)).trim(),
  },
  installParity: true,
  lockfileParity: true,
  postinstallVerified: true,
  metadataPreserved: true,
  originalCommandsAfterOptimization: true,
  volumeAvailableBefore: before,
  volumeAvailableAfter: after,
  measuredReclaimedBytes: reclaimed,
  sharedLogicalBytes: reports.reduce((n, r) => n + r.sharedLogicalBytes, 0),
  reports,
  combinedReport,
  cloneEvidence,
  commands,
};
await writeFile(
  join(output, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
await writeFile(
  join(repository, ".work", "validation", "latest.json"),
  JSON.stringify({ output, result: join(output, "result.json") }, null, 2) +
    "\n",
);
console.log(`Validation passed. Report: ${join(output, "result.json")}`);
