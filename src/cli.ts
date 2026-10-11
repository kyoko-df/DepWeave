import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Engine } from "./engine.js";
import {
  detect,
  nativeArgs,
  rejectRedirects,
  runNative,
  resolveLauncher,
  type Manager,
} from "./project.js";
import {
  atomicJson,
  discoverStore,
  home,
  projectKey,
  settings,
  type Provider,
} from "./store.js";
import { optimize, withProjectLock, type Report } from "./optimize.js";

function output(report: Report, json: boolean) {
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(
      `DepWeave: ${report.dryRun ? "preview" : "optimized"} ${report.clonedFiles} files; ${(report.sharedLogicalBytes / 1048576).toFixed(2)} MiB of logical content shared (${report.provider}).`,
    );
    console.log(
      `Seeded ${report.seededFiles}; unchanged ${report.alreadyOptimized}; skipped ${report.skippedFiles}; errors ${report.errors.length}.`,
    );
    console.log("Logical shared bytes are not measured reclaimed disk space.");
    for (const error of report.errors.slice(0, 5)) console.error(error);
  }
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let cwd = process.cwd(),
    pm: Manager | undefined,
    provider: Provider | undefined,
    storePath: string | undefined;
  let dry = false,
    json = false,
    noOptimize = false,
    required = false,
    projectConfig = false,
    min = 4096;
  const positional: string[] = [],
    native: string[] = [];
  const divider = argv.indexOf("--");
  if (divider >= 0) {
    native.push(...argv.slice(divider + 1));
    argv = argv.slice(0, divider);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--cwd") cwd = resolve(value());
    else if (a === "--pm") pm = value() as Manager;
    else if (a === "--store-provider") provider = value() as Provider;
    else if (a === "--store-path" || a === "--path")
      storePath = resolve(value());
    else if (a === "--min-file-bytes") min = Number(value());
    else if (a === "--dry-run") dry = true;
    else if (a === "--json") json = true;
    else if (a === "--no-optimize") noOptimize = true;
    else if (a === "--require-optimize") required = true;
    else if (a === "--project") projectConfig = true;
    else positional.push(a);
  }
  if (pm && !["npm", "yarn"].includes(pm))
    throw new Error("--pm must be npm or yarn.");
  if (provider && !["own", "pnpm", "yarn"].includes(provider))
    throw new Error("Unknown storage provider.");
  if (!Number.isSafeInteger(min) || min < 0)
    throw new Error("Invalid minimum file size.");
  const command = positional.shift() ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    console.log(
      `DepWeave 0.1.0-alpha.1 — original npm/Yarn, APFS copy-on-write\n\nCommands: install, add, remove, pm -- <native command>, optimize, doctor, store use <own|pnpm|yarn>\nOptions: --cwd <project>, --pm npm|yarn, --store-provider <provider>, --store-path <path>\n         --dry-run (optimize only), --json, --no-optimize, --require-optimize, --min-file-bytes <n>\nSet DEPWEAVE_HOME to a private directory on the same APFS filesystem.\nOptimize only while no other installer, build, or patch process writes the dependency tree.`,
    );
    return 0;
  }
  if (command === "--version") {
    console.log("0.1.0-alpha.1");
    return 0;
  }
  if (process.platform !== "darwin" && !noOptimize)
    throw new Error("The APFS MVP requires macOS.");
  const config = await settings();
  if (command === "store") {
    if (positional.shift() !== "use")
      throw new Error("Use: depweave store use own|pnpm|yarn");
    const selected = positional.shift() as Provider;
    if (!["own", "pnpm", "yarn"].includes(selected))
      throw new Error("Unknown storage provider.");
    await discoverStore(selected, storePath, cwd);
    const store = { provider: selected, path: storePath };
    if (projectConfig) {
      const project = await detect(cwd, pm);
      config.projects[projectKey(project.root)] = store;
    } else config.store = store;
    await mkdir(home(), { recursive: true, mode: 0o700 });
    await atomicJson(join(home(), "config.json"), config);
    console.log(
      `DepWeave: ${projectConfig ? "project" : "default"} storage provider is ${selected}.`,
    );
    return 0;
  }
  if (
    !["install", "add", "remove", "pm", "optimize", "doctor"].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  if (dry && command !== "optimize")
    throw new Error(
      "--dry-run is supported by optimize only; it never runs an installation.",
    );
  const project = await detect(cwd, pm);
  const store = config.projects[projectKey(project.root)] ?? config.store;
  const location = noOptimize
    ? { provider: "own" as const, format: "disabled" }
    : await discoverStore(
        provider ?? store.provider,
        storePath ?? store.path,
        project.root,
      );
  if (command === "doctor") {
    const engine = new Engine();
    try {
      const result = {
        platform: process.platform,
        manager: project.manager,
        evidence: project.evidence,
        cwd: project.cwd,
        root: project.root,
        home: home(),
        store: location,
        volume: await engine.request({ op: "volume", path: project.root }),
      };
      console.log(JSON.stringify(result, null, 2));
      return result.volume.apfs ? 0 : 2;
    } finally {
      await engine.close();
    }
  }
  const args = nativeArgs(project.manager, command, [...positional, ...native]);
  const autoOptimize =
    command !== "pm" ||
    [
      "install",
      "i",
      "ci",
      "add",
      "remove",
      "uninstall",
      "update",
      "up",
      "upgrade",
    ].includes(args[0]);
  if (!noOptimize && command !== "optimize") rejectRedirects(args);
  const launcher =
    command === "optimize" ? undefined : await resolveLauncher(project);
  const work = async () => {
    const engine = noOptimize ? undefined : new Engine();
    try {
      if (engine) {
        const volume = await engine.request({
          op: "volume",
          path: project.root,
        });
        if (!volume.apfs)
          throw new Error(
            "APFS required. Use --no-optimize to run the original tool alone.",
          );
      }
      if (command !== "optimize") {
        if (!json)
          console.error(`DepWeave → ${project.manager} ${args.join(" ")}`);
        const result = await runNative(project, args, json, launcher!);
        if (result.code !== 0 || result.signal) return result.code;
        if (noOptimize || !autoOptimize) return 0;
      }
      try {
        const report = await optimize(
          project.root,
          { dryRun: dry, min, location },
          engine!,
        );
        output(report, json);
        return report.errors.length && (required || command === "optimize")
          ? 3
          : 0;
      } catch (error: any) {
        if (command === "optimize" || required) throw error;
        console.error(
          `DepWeave: original installation succeeded; optimization did not complete: ${error.message}`,
        );
        return 0;
      }
    } finally {
      await engine?.close();
    }
  };
  return dry ? work() : withProjectLock(project.root, work);
}
