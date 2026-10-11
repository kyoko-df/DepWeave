import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, realpath, lstat, glob } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type Manager = "npm" | "yarn";
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function jsonFile(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}
export interface Project {
  cwd: string;
  root: string;
  manager: Manager;
  evidence: string;
}

async function workspaceDirectories(
  root: string,
  manifest: any,
): Promise<string[]> {
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;
  if (!patterns) return [];
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string"))
    throw new Error("Unsupported workspace declaration.");
  const directories: string[] = [];
  const excludes = patterns
    .filter((p: string) => p.startsWith("!"))
    .map((p: string) => p.slice(1));
  for await (const relative of glob(
    patterns.filter((p: string) => !p.startsWith("!")),
    { cwd: root, exclude: ["**/node_modules/**", "**/.git/**", ...excludes] },
  )) {
    const path = resolve(root, relative);
    if (
      !path.startsWith(root + "/") ||
      !(await lstat(path)).isDirectory() ||
      (await realpath(path)) !== path
    )
      continue;
    if (await exists(join(path, "package.json"))) directories.push(path);
  }
  return [...new Set(directories)];
}

export async function detect(
  cwd: string,
  explicit?: Manager,
): Promise<Project> {
  cwd = await realpath(cwd);
  let dir = cwd;
  let root: string | undefined;
  let nearest: string | undefined;
  while (true) {
    if (await exists(join(dir, "package.json"))) {
      const manifest = await jsonFile(join(dir, "package.json"));
      if (!nearest) {
        nearest = dir;
        root = dir;
      } else if (
        manifest.workspaces &&
        (await workspaceDirectories(dir, manifest)).includes(nearest)
      ) {
        root = dir;
        break;
      }
    }
    if (dirname(dir) === dir || (nearest && (await exists(join(dir, ".git")))))
      break;
    dir = dirname(dir);
  }
  if (!root)
    throw new Error("No package.json found. Run inside a Node.js project.");
  const manifest = await jsonFile(join(root, "package.json"));
  const field =
    manifest.packageManager?.split("@")[0] ??
    manifest.devEngines?.packageManager?.name;
  const npmLock =
    (await exists(join(root, "package-lock.json"))) ||
    (await exists(join(root, "npm-shrinkwrap.json")));
  const yarnLock = await exists(join(root, "yarn.lock"));
  if (explicit) return { cwd, root, manager: explicit, evidence: "--pm" };
  if (field && !["npm", "yarn"].includes(field))
    throw new Error(
      `Project declares ${field}; this MVP wraps npm and Yarn only. Use --pm explicitly if intended.`,
    );
  if (npmLock && yarnLock)
    throw new Error(
      "Both npm and Yarn lockfiles exist; choose --pm npm or --pm yarn.",
    );
  if ((field === "npm" && yarnLock) || (field === "yarn" && npmLock))
    throw new Error(
      "packageManager conflicts with the lockfile; choose --pm explicitly.",
    );
  const manager = field ?? (yarnLock ? "yarn" : npmLock ? "npm" : undefined);
  if (!manager)
    throw new Error(
      "Package manager is ambiguous; choose --pm npm or --pm yarn.",
    );
  return { cwd, root, manager, evidence: field ? "package.json" : "lockfile" };
}

// Discover actual node_modules directories in the project. Never follow links
// into workspaces, file: dependencies, or directories outside the project.
export async function moduleRoots(root: string): Promise<string[]> {
  const directories = [
    root,
    ...(await workspaceDirectories(
      root,
      await jsonFile(join(root, "package.json")),
    )),
  ];
  const found: string[] = [];
  for (const dir of directories) {
    const path = join(dir, "node_modules");
    if (
      (await exists(path)) &&
      (await lstat(path)).isDirectory() &&
      (await realpath(path)) === path
    )
      found.push(path);
  }
  return found;
}

export interface Launcher {
  command: string;
  prefix: string[];
  version: string;
}
export async function resolveLauncher(project: Project): Promise<Launcher> {
  let command: string = project.manager,
    prefix: string[] = [];
  const rc = join(project.root, ".yarnrc.yml");
  if (project.manager === "yarn" && (await exists(rc))) {
    const line = (await readFile(rc, "utf8")).match(
      /^yarnPath:\s*(.+?)\s*$/m,
    )?.[1];
    if (line && line !== "false") {
      let path: string;
      if (line.startsWith('"')) path = JSON.parse(line);
      else if (line.startsWith("'"))
        path = line.slice(1, -1).replace(/''/g, "'");
      else {
        if (/[&*!{}\[\]]/.test(line))
          throw new Error(
            "Complex yarnPath syntax is not supported; use the original launcher.",
          );
        path = line.replace(/\s+#.*$/, "");
      }
      command = process.execPath;
      prefix = [resolve(project.root, path)];
    }
  }
  const result = await promisify(execFile)(command, [...prefix, "--version"], {
    cwd: project.cwd,
  });
  const version = result.stdout.trim();
  const pin = (await jsonFile(join(project.root, "package.json")))
    .packageManager;
  const requested =
    typeof pin === "string"
      ? pin.match(/^(npm|yarn)@(\d+\.\d+\.\d+(?:-[^+]+)?)/)
      : null;
  if (requested && requested[1] === project.manager && requested[2] !== version)
    throw new Error(
      `Project pins ${pin}, but its original launcher reports ${version}. Use the project's existing launcher/Corepack configuration; DepWeave does not switch versions.`,
    );
  return { command, prefix, version };
}

export interface NativeResult {
  code: number;
  signal: NodeJS.Signals | null;
}
export function runNative(
  project: Project,
  args: string[],
  jsonOutput: boolean,
  launcher: Launcher,
): Promise<NativeResult> {
  return new Promise((accept, reject) => {
    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      cwd: project.cwd,
      env: process.env,
      stdio: jsonOutput ? ["inherit", 2, 2] : "inherit",
      shell: false,
    });
    let interrupted: NodeJS.Signals | null = null;
    const forward = (signal: NodeJS.Signals) => {
      interrupted = signal;
      child.kill(signal);
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const clean = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    child.once("error", (e) => {
      clean();
      reject(new Error(`Cannot start ${project.manager}: ${e.message}`));
    });
    child.once("exit", (code, signal) => {
      clean();
      const stopped = signal ?? interrupted;
      accept({
        code: stopped ? (stopped === "SIGINT" ? 130 : 143) : (code ?? 1),
        signal: stopped,
      });
    });
  });
}

export function nativeArgs(
  manager: Manager,
  command: string,
  args: string[],
): string[] {
  if (command === "pm") return args;
  const mapped =
    command === "add"
      ? manager === "npm"
        ? "install"
        : "add"
      : command === "remove"
        ? manager === "npm"
          ? "uninstall"
          : "remove"
        : "install";
  return [mapped, ...args];
}

export function rejectRedirects(args: string[]): void {
  const redirects = [
    "--prefix",
    "--cwd",
    "--dir",
    "-C",
    "--global",
    "-g",
    "--global-folder",
    "--modules-folder",
  ];
  if (
    args.some((a) =>
      redirects.some((flag) => a === flag || a.startsWith(flag + "=")),
    )
  ) {
    throw new Error(
      "Directory redirects and global installs are outside MVP optimization scope. Use --no-optimize or --cwd before --.",
    );
  }
}
