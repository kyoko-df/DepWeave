import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  symlink,
  chmod,
  utimes,
  readdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { Engine } from "../dist/engine.js";
import { optimize, withProjectLock } from "../dist/optimize.js";
import { detect } from "../dist/project.js";
import { contentHash, discoverStore } from "../dist/store.js";

const work = resolve(".work/tests");
await mkdir(work, { recursive: true });
const cli = resolve("bin/depweave.mjs");
const own = { provider: "own", format: "depweave-sha256-v1" };
async function fixture(t) {
  const root = await mkdtemp(join(work, "case-"));
  process.env.DEPWEAVE_HOME = join(root, "state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(join(project, "node_modules", "demo"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "fixture", packageManager: "npm@10.9.3" }),
  );
  return { root, project, modules: join(project, "node_modules", "demo") };
}
async function using(t, fn) {
  const engine = new Engine();
  try {
    await fn(engine);
  } finally {
    await engine.close();
  }
}
const opts = (extra = {}) => ({
  dryRun: false,
  min: 4096,
  location: own,
  ...extra,
});

test("APFS sharing has independent inode, preserves contents, and isolates writes", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(1024 * 1024);
  const a = join(f.modules, "a.js"),
    b = join(f.modules, "b.js");
  await writeFile(a, bytes);
  await writeFile(b, bytes);
  await using(t, async (engine) => {
    const result = await optimize(f.project, opts(), engine);
    assert.equal(result.errors.length, 0, result.errors.join("\n"));
    assert.equal(result.clonedFiles, 1);
    assert.equal(result.seededFiles, 1);
    assert.notEqual((await lstat(a)).ino, (await lstat(b)).ino);
    assert.deepEqual(await readFile(b), bytes);
    const ai = await engine.info(a),
      bi = await engine.info(b);
    assert.equal(ai.cloneId, bi.cloneId);
    assert.notEqual(ai.cloneId, "0");
    const { open } = await import("node:fs/promises");
    const fd = await open(b, "r+");
    await fd.write(Buffer.from("changed"), 0, 7, 0);
    await fd.close();
    assert.deepEqual(await readFile(a), bytes);
    assert.notDeepEqual(await readFile(b), bytes);
    const storeFiles = (await import("../dist/store.js")).walkFiles;
    for (const object of await storeFiles(join(f.root, "state", "stores")))
      assert.deepEqual(await readFile(object), bytes);
  });
});
test("replacement preserves mode, nanosecond mtime, birthtime and target xattrs", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(65536),
    a = join(f.modules, "a"),
    b = join(f.modules, "b");
  await writeFile(a, bytes);
  await writeFile(b, bytes);
  await chmod(b, 0o755);
  await utimes(b, 1234567890.123, 1234567891.456);
  execFileSync("/usr/bin/xattr", ["-w", "user.source", "only-a", a]);
  execFileSync("/usr/bin/xattr", ["-w", "user.target", "only-b", b]);
  const before = await lstat(b, { bigint: true });
  await using(t, async (engine) => {
    const r = await optimize(f.project, opts(), engine);
    assert.equal(r.errors.length, 0, r.errors.join("\n"));
    assert.equal(r.clonedFiles, 1);
  });
  const after = await lstat(b, { bigint: true });
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.birthtimeNs, before.birthtimeNs);
  assert.equal(
    execFileSync("/usr/bin/xattr", ["-p", "user.target", b], {
      encoding: "utf8",
    }).trim(),
    "only-b",
  );
  assert.equal(
    spawnSync("/usr/bin/xattr", ["-p", "user.source", b], { stdio: "pipe" })
      .status,
    1,
  );
});
test("ACL is restored from target, not inherited from cached source", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(65536),
    a = join(f.modules, "a"),
    b = join(f.modules, "b");
  await writeFile(a, bytes);
  await writeFile(b, bytes);
  execFileSync("/bin/chmod", ["+a", "everyone allow read", b]);
  const aclBefore = execFileSync("/bin/ls", ["-le", b], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .join("\n");
  await using(t, async (engine) => {
    const r = await optimize(f.project, opts(), engine);
    assert.equal(r.errors.length, 0, r.errors.join("\n"));
    assert.equal(r.clonedFiles, 1);
  });
  assert.equal(
    execFileSync("/bin/ls", ["-le", b], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .join("\n"),
    aclBefore,
  );
});
test("target without an ACL does not acquire the cached source ACL", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(65536),
    a = join(f.modules, "a"),
    b = join(f.modules, "b");
  await writeFile(a, bytes);
  await writeFile(b, bytes);
  execFileSync("/bin/chmod", ["+a", "everyone allow read", a]);
  await using(t, async (engine) => {
    const r = await optimize(f.project, opts(), engine);
    assert.equal(r.errors.length, 0, r.errors.join("\n"));
    assert.equal(r.clonedFiles, 1);
  });
  assert.equal(
    execFileSync("/bin/ls", ["-le", b], { encoding: "utf8" }).trim().split("\n")
      .length,
    1,
  );
});
test("dry-run leaves files and storage unchanged", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(8192),
    a = join(f.modules, "a"),
    b = join(f.modules, "b");
  await writeFile(a, bytes);
  await writeFile(b, bytes);
  const before = await lstat(b);
  await using(t, async (engine) => {
    const r = await optimize(f.project, opts({ dryRun: true }), engine);
    assert.equal(r.clonedFiles, 1);
  });
  assert.equal((await lstat(b)).ino, before.ino);
  assert.equal((await readdir(f.root)).includes("state"), false);
});
test("second optimization is idempotent, modified file gets a new content key", async (t) => {
  const f = await fixture(t),
    a = join(f.modules, "a"),
    b = join(f.modules, "b"),
    bytes = randomBytes(8192);
  await writeFile(a, bytes);
  await writeFile(b, bytes);
  await using(t, async (engine) => {
    await optimize(f.project, opts(), engine);
    const inode = (await lstat(b)).ino;
    const repeat = await optimize(f.project, opts(), engine);
    assert.equal(repeat.clonedFiles, 0);
    assert.equal(repeat.alreadyOptimized, 2);
    assert.equal((await lstat(b)).ino, inode);
    await writeFile(b, randomBytes(8192));
    const changed = await optimize(f.project, opts(), engine);
    assert.equal(changed.seededFiles, 1);
    assert.equal(changed.errors.length, 0);
  });
});
test("scanner does not follow workspace, package or file symlinks", async (t) => {
  const f = await fixture(t),
    outside = join(f.root, "external");
  await mkdir(outside);
  await writeFile(join(outside, "a"), randomBytes(8192));
  await symlink(outside, join(f.project, "node_modules", "workspace"));
  await symlink(join(outside, "a"), join(f.modules, "file-link"));
  const inode = (await lstat(join(outside, "a"))).ino;
  await using(t, async (engine) => {
    const r = await optimize(f.project, opts(), engine);
    assert.equal(r.scannedFiles, 0);
  });
  assert.equal((await lstat(join(outside, "a"))).ino, inode);
  assert.ok((await lstat(join(f.modules, "file-link"))).isSymbolicLink());
});
test("ambiguous managers require explicit choice", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, "package-lock.json"), "{}");
  await writeFile(join(f.project, "yarn.lock"), "");
  await assert.rejects(detect(f.project), /Both npm and Yarn/);
  assert.equal((await detect(f.project, "yarn")).manager, "yarn");
});
test("corrupt cache cannot replace project file", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(8192),
    a = join(f.modules, "a");
  await writeFile(a, bytes);
  await using(t, async (engine) => {
    await optimize(f.project, opts(), engine);
    const { walkFiles } = await import("../dist/store.js");
    const [object] = await walkFiles(join(f.root, "state", "stores"));
    await chmod(object, 0o600);
    await writeFile(object, randomBytes(bytes.length));
    const b = join(f.modules, "b");
    await writeFile(b, bytes);
    const r = await optimize(f.project, opts(), engine);
    assert.equal(r.errors.length, 1);
    assert.deepEqual(await readFile(b), bytes);
  });
});
test("native command and failure code are forwarded without post-optimization", async (t) => {
  const f = await fixture(t),
    bin = join(f.root, "bin");
  await mkdir(bin);
  const fake = join(bin, "npm");
  await writeFile(
    fake,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "10.9.3\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$ARGS_FILE"\nexit 37\n',
  );
  await chmod(fake, 0o755);
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    ARGS_FILE: join(f.root, "args"),
  };
  const result = spawnSync(
    process.execPath,
    [cli, "install", "--cwd", f.project, "--", "--ignore-scripts"],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 37, result.stderr);
  assert.equal(
    await readFile(env.ARGS_FILE, "utf8"),
    "install\n--ignore-scripts\n",
  );
  assert.equal((await readdir(f.root)).includes("state"), true);
  assert.deepEqual(await readdir(f.modules), []);
});
test("active project lock prevents simultaneous mutation", async (t) => {
  const f = await fixture(t);
  await withProjectLock(f.project, async () => {
    await assert.rejects(
      withProjectLock(f.project, async () => {}),
      /Another DepWeave/,
    );
  });
});
test("recovery cleans recorded before-swap clone and leaves original untouched", async (t) => {
  const f = await fixture(t),
    a = join(f.modules, "a"),
    bytes = randomBytes(8192);
  await writeFile(a, bytes);
  const { projectKey } = await import("../dist/store.js");
  const journal = join(
    f.root,
    "state",
    "projects",
    projectKey(f.project),
    "journal",
  );
  await mkdir(journal, { recursive: true });
  const temp = join(f.modules, ".depweave-recovery");
  await writeFile(temp, bytes);
  const hash = await contentHash(a);
  await writeFile(
    join(journal, "recovery.json"),
    JSON.stringify({ target: a, temp, hash }),
  );
  const before = (await lstat(a)).ino;
  await using(t, async (engine) => {
    const r = await optimize(f.project, opts(), engine);
    assert.equal(r.errors.length, 0);
  });
  assert.equal((await lstat(a)).ino, before);
  assert.equal(
    (await readdir(f.modules)).includes(".depweave-recovery"),
    false,
  );
  assert.deepEqual(await readdir(journal), []);
});
test("unsupported store layouts fail explicitly instead of changing backends", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    discoverStore("pnpm", f.root, f.project),
    /supports the pnpm 10/,
  );
});

test("new Yarn project never inherits unrelated parent npm identity", async (t) => {
  const f = await fixture(t),
    child = join(f.project, "independent");
  await mkdir(child);
  await writeFile(join(f.project, "package-lock.json"), "{}");
  await writeFile(
    join(child, "package.json"),
    JSON.stringify({ name: "child", packageManager: "yarn@1.22.19" }),
  );
  const project = await detect(child);
  assert.equal(project.root, child);
  assert.equal(project.manager, "yarn");
});
test("workspace detection optimizes declared members and excludes unrelated examples", async (t) => {
  const f = await fixture(t),
    member = join(f.project, "packages", "member"),
    unrelated = join(f.project, "examples", "independent");
  for (const dir of [member, unrelated]) {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}");
  }
  await writeFile(
    join(f.project, "package.json"),
    JSON.stringify({
      name: "root",
      packageManager: "npm@10.9.3",
      workspaces: ["packages/*"],
    }),
  );
  assert.equal((await detect(member)).root, f.project);
  const { moduleRoots } = await import("../dist/project.js");
  assert.deepEqual(await moduleRoots(f.project), [
    join(f.project, "node_modules"),
    join(member, "node_modules"),
  ]);
  assert.equal((await detect(unrelated, "npm")).root, unrelated);
});
test("CLI dry-run does not create a storage or lock directory", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.modules, "a"), randomBytes(8192));
  const result = spawnSync(
    process.execPath,
    [cli, "optimize", "--cwd", f.project, "--dry-run", "--json"],
    { env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(f.root)).includes("state"), false);
});
