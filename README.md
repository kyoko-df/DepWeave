# DepWeave

Keep npm and Yarn. Share identical dependency file data with APFS copy-on-write.

This is an **alpha MVP for macOS APFS**, not the full v0.1 roadmap. DepWeave runs the project's original npm or Yarn command, then deduplicates ordinary installed files without rewriting package manifests, lockfiles, module paths, or dependency symlinks. Adding/removing dependencies still changes the project through its original package manager.

## Build and run

Requires Node.js 22+, Rust, and the macOS command-line developer tools. No daemon or root permission is needed.

```sh
npm ci
npm run build
node bin/depweave.mjs --help

# Run against an existing npm/Yarn project.
node /path/to/DepWeave/bin/depweave.mjs install --cwd /path/to/project

# Use a private state directory on the SAME APFS filesystem as the project.
DEPWEAVE_HOME=/path/to/cache node bin/depweave.mjs optimize --cwd /path/to/project --dry-run
DEPWEAVE_HOME=/path/to/cache node bin/depweave.mjs optimize --cwd /path/to/project
```

After building, `npm link` is optional if you want `depweave` on PATH; DepWeave itself does not install or replace global commands.

## Commands

```sh
depweave install
depweave add lodash
depweave add -D typescript
depweave remove lodash
depweave pm -- ci                    # native npm syntax
depweave pm -- upgrade lodash        # native Yarn Classic syntax
depweave optimize --dry-run
depweave optimize --json
depweave doctor

depweave store use own
depweave store use pnpm --path /path/to/pnpm-store/v10
depweave store use yarn --path /path/to/yarn/global/store/v1
depweave store use own --project     # user state, not project configuration
depweave install --store-provider own
depweave install --no-optimize
depweave install --require-optimize
depweave install -- --ignore-scripts # args after -- go to the original tool
```

`install`, `add`, `remove` map to native npm/Yarn verbs. `pm --` forwards native arguments; recognized install/mutation verbs are optimized afterwards, other commands are just forwarded. Redirection/global-install flags are rejected unless `--no-optimize` is used. `--dry-run` is only available for `optimize` and never installs packages or creates storage.

Package-manager detection uses the nearest package and its declared workspace membership. Conflicting identities require `--pm npm` or `--pm yarn`. Exact `packageManager` pins are checked against the selected launcher; a mismatch fails before installation. Existing `.yarnrc.yml` `yarnPath` is honored for simple scalar paths. DepWeave never changes versions or pins. An available Corepack shim may perform its own normal provisioning.

Default state is `~/Library/Application Support/DepWeave`. `DEPWEAVE_HOME` overrides it, including user config, project settings, object store, per-project locks, and recovery journals. Store selection is independent of the installer. Changing the provider does not change npm into pnpm, or Yarn into npm.

## File sharing

Files are matched by SHA-256 and length. A new content object is seeded by `fclonefileat`; matching installed files are replaced with APFS clones. Each project retains independent inodes and private metadata. Native `fcopyfile` restores target metadata, then `renameatx_np(RENAME_SWAP)` exchanges files atomically. The old file is retained until the exchange is verified.

The MVP preserves ordinary mode bits, owner/group, mtime, birthtime, ACLs and extended attributes; regression tests cover these. ctime/inode and directory timestamps can change. Special modes, BSD flags, existing hardlinks, symlinks, hidden installation/cache files, and files below 4 KiB are skipped. `--min-file-bytes` can change the size threshold. Workspace package symlinks are preserved; only root and declared workspace member installation directories are traversed.

**Optimize only while the dependency tree is idle.** DepWeave locks coordinate its own processes, not external installers/builds/patch tools. File-change checks reduce races but do not guarantee safe coordination with arbitrary concurrent writers. Cloning can trigger filesystem watchers. Interrupted exchanges are cleaned up on the next optimization; if either copy changed, recovery stops and keeps both copies for inspection. Original dependency changes are never rolled back.

No hardlink or ordinary-copy fallback is used. Non-APFS filesystems cannot optimize. The state directory must be on the project's filesystem. Candidates on another filesystem are skipped in this MVP. Yarn PnP commands can be forwarded, but PnP caches and loaders are not optimized.

## Storage providers

| Provider | Current capability                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------- |
| `own`    | Default; writable SHA-256 object store, seeded via APFS clones                                      |
| `pnpm`   | Read-only preview for the pnpm 10 `v10/files` layout; active path discovered with `pnpm store path` |
| `yarn`   | Read-only preview for modern Yarn's unpacked `store/v1`; not its zip cache                          |

External content is checked by actual bytes before use; no external index is trusted as a checksum proof. Misses go to the private DepWeave store. The MVP does not populate native pnpm/Yarn caches, mutate their indexes, or invoke their garbage collection. External discovery and indexing are currently rescanned per operation, not a persistent SQLite index. Unknown pnpm layouts fail explicitly. Yarn store paths require users to select the unpacked `store/v1` layout.

Authentic pnpm 10.13.1 and Yarn 4.9.2 stores were validated for read-only reuse. Other versions remain outside the verified matrix; these private storage layouts are version-specific. The current adapters rescan candidates and are intended for MVP validation, not unbounded production stores.

## Reports and exit status

Human reports show processed files and **logical bytes shared**, not claimed disk reclamation. JSON also includes APFS private-byte attributes (when supported) and volume available-space observations. On a busy main volume, space changes cannot be attributed solely to DepWeave.

Original command failure returns its native exit status (SIGINT 130, SIGTERM 143) and skips optimization. A successful install with optimization problems reports the problems and normally returns success. `--require-optimize` and standalone `optimize` fail when optimization does not complete (code 3 for per-file errors, code 2 for command/preflight errors).

## Test and measure

```sh
npm run build
npm test

# A clean, isolated APFS volume makes available-space measurements meaningful.
mkdir -p .work
hdiutil create -size 512m -type SPARSE -fs APFS -volname DepWeaveValidation .work/validation-volume
hdiutil attach -nobrowse -mountpoint "$PWD/.work/volume" .work/validation-volume.sparseimage
npm run validate
hdiutil detach "$PWD/.work/volume"
```

`validate` uses network access to install TypeScript 5.9.3 and lodash 4.17.21 with real npm and Yarn Classic. It compares direct vs wrapped installs, checks lockfiles and postinstall behavior, deduplicates four installations, measures actual available-space change on the isolated filesystem, checks clone IDs and independent mutation, and verifies subsequent native add/remove operations. Reports and command logs are written outside the measurement volume to `.work/validation/`.

For the additional authentic-store and modern-Yarn checks, keep the validation volume mounted and run these before detaching:

```sh
npm install --prefix .work/tooling @yarnpkg/cli-dist@4.9.2 --cache .work/npm-cache --ignore-scripts --no-audit --no-fund
npm run validate:providers
```

The local validation measured **76,140,544 bytes (72.61 MiB)** of increased available space after optimizing four installations. This is the observed result for that isolated fixture, including filesystem allocation effects. It is separate from the 72,877,218 logical bytes shared. See `docs/VALIDATION.md` for evidence and limits.

Use `DEPWEAVE_VALIDATION_ROOT` to select a disposable filesystem. Measurements on the main system volume are affected by unrelated activity and do not prove reclaimed space. The tested fixture represents repeated identical dependencies, not a general saving percentage or a speed benchmark.

## Next work

Broader package-manager version fixtures, persistent indexing, bounded scanning, per-filesystem automatic storage placement, more interruption/recovery cases, and Linux reflinks come next. Download/extraction acceleration and a virtual filesystem are separate future work; post-install sharing does not avoid the original installer's downloads or peak storage.
