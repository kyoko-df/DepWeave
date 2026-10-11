import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "../dist/store.js";

const repository = resolve("."),
  latest = JSON.parse(await readFile(".work/validation/latest.json", "utf8"));
const baseline = JSON.parse(await readFile(latest.result, "utf8"));
const root = join(
  resolve(process.env.DEPWEAVE_VALIDATION_ROOT ?? ".work/volume"),
  "providers-" + randomUUID(),
);
const tooling = resolve(
  ".work/tooling/node_modules/@yarnpkg/cli-dist/bin/yarn.js",
);
await mkdir(root, { recursive: true });
const commands = [];
async function run(command, args, cwd, home) {
  let stdout = "",
    stderr = "";
  const code = await new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, DEPWEAVE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.once("error", reject);
    child.once("exit", done);
  });
  commands.push({ command, args, cwd, code });
  await writeFile(
    join(latest.output, `provider-command-${commands.length}.log`),
    stdout + stderr,
  );
  assert.equal(code, 0, `${command} ${args.join(" ")}\n${stdout}\n${stderr}`);
  return stdout;
}
async function fixture(name, manager) {
  const path = join(root, name);
  await mkdir(path);
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      name: "provider-validation",
      version: "1.0.0",
      private: true,
      packageManager: manager,
      dependencies: { typescript: "5.9.3", lodash: "4.17.21" },
    }),
  );
  return path;
}
async function snapshot(root) {
  const result = {};
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile())
        result[relative(root, path)] = {
          hash: await contentHash(path),
          mode: (await lstat(path)).mode,
        };
    }
  }
  await visit(root);
  return result;
}
const cli = resolve("bin/depweave.mjs");
console.log("Validating authentic pnpm 10 store reuse…");
const pnpmRoot = join(root, "pnpm-store"),
  pnpmHome = join(root, "pnpm-state");
await run(
  "pnpm",
  [
    "store",
    "add",
    "typescript@5.9.3",
    "lodash@4.17.21",
    "--store-dir",
    pnpmRoot,
  ],
  root,
  pnpmHome,
);
const pnpmPath = (
  await run("pnpm", ["store", "path", "--store-dir", pnpmRoot], root, pnpmHome)
).trim();
const npmProject = await fixture("npm-victim", "npm@10.9.3");
await run(
  "npm",
  [
    "install",
    "--cache",
    join(baseline.root, "npm-cache"),
    "--no-audit",
    "--no-fund",
  ],
  npmProject,
  pnpmHome,
);
const pnpmBefore = await snapshot(pnpmPath),
  npmBefore = await snapshot(join(npmProject, "node_modules"));
const pnpmReport = JSON.parse(
  await run(
    process.execPath,
    [
      cli,
      "optimize",
      "--cwd",
      npmProject,
      "--store-provider",
      "pnpm",
      "--store-path",
      pnpmPath,
      "--json",
    ],
    repository,
    pnpmHome,
  ),
);
assert.ok(pnpmReport.externalHits > 0);
assert.equal(pnpmReport.errors.length, 0);
assert.deepEqual(await snapshot(pnpmPath), pnpmBefore);
assert.deepEqual(await snapshot(join(npmProject, "node_modules")), npmBefore);

console.log(
  "Validating original Yarn 4 launcher and authentic global store reuse…",
);
const global = join(root, "yarn-global"),
  yarnHome = join(root, "yarn-state");
const source = await fixture("yarn-source", "yarn@4.9.2"),
  victim = await fixture("yarn-victim", "yarn@4.9.2");
for (const [project, mode] of [
  [source, "hardlinks-global"],
  [victim, "classic"],
]) {
  await writeFile(
    join(project, ".yarnrc.yml"),
    `yarnPath: ${JSON.stringify(tooling)}\nnodeLinker: node-modules\nnmMode: ${mode}\nglobalFolder: ${JSON.stringify(global)}\nnpmRegistryServer: "https://registry.npmjs.org"\n`,
  );
  // Modern Yarn requires an explicit boundary for standalone projects nested
  // under another package. This is fixture setup, not a wrapper mutation.
  await writeFile(join(project, "yarn.lock"), "");
}
await run(process.execPath, [tooling, "install"], source, yarnHome);
const yarnStore = join(global, "store", "v1"),
  yarnBefore = await snapshot(yarnStore);
const yarnReport = JSON.parse(
  await run(
    process.execPath,
    [
      cli,
      "install",
      "--cwd",
      victim,
      "--store-provider",
      "yarn",
      "--store-path",
      yarnStore,
      "--require-optimize",
      "--json",
    ],
    repository,
    yarnHome,
  ),
);
assert.ok(yarnReport.externalHits > 0);
assert.equal(yarnReport.errors.length, 0);
assert.equal(
  await readFile(join(source, "yarn.lock"), "utf8"),
  await readFile(join(victim, "yarn.lock"), "utf8"),
);
assert.deepEqual(await snapshot(yarnStore), yarnBefore);
await run(
  process.execPath,
  [
    "-e",
    "if(require('lodash').sum([1,2,3])!==6)process.exit(1);console.log(require('typescript').version)",
  ],
  victim,
  yarnHome,
);
await run(
  process.execPath,
  [cli, "add", "minimist@1.2.8", "--cwd", victim, "--require-optimize"],
  repository,
  yarnHome,
);
assert.match(
  JSON.parse(await readFile(join(victim, "package.json"), "utf8")).dependencies
    .minimist,
  /^[~^]?1\.2\.8$/,
);
await run(
  process.execPath,
  [cli, "remove", "minimist", "--cwd", victim, "--require-optimize"],
  repository,
  yarnHome,
);
const result = {
  pnpmVersion: (await run("pnpm", ["--version"], repository, pnpmHome)).trim(),
  yarnVersion: (
    await run(process.execPath, [tooling, "--version"], repository, yarnHome)
  ).trim(),
  pnpmReport,
  yarnReport,
  externalStoresUnchanged: true,
  modernYarnOriginalLauncher: true,
  modernYarnAddRemove: true,
  commands,
};
await writeFile(
  join(latest.output, "providers.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  `Provider validation passed: pnpm hits ${pnpmReport.externalHits}; Yarn hits ${yarnReport.externalHits}.`,
);
