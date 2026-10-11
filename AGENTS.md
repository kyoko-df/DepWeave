# DepWeave Development Guide

## Project Goal

DepWeave invokes a project's existing npm or Yarn to manage dependencies, then shares identical installed files through APFS copy-on-write. The package manager and storage provider are independent choices.

The current implementation is a macOS APFS MVP. README.md and the implementation define the supported features and scope. The docs/ directory contains local design notes and validation records; it is ignored by Git and must not be required for development.

## Code Layout

- src/: TypeScript CLI, project detection, original package manager execution, storage adapters, and optimization flow.
- native/src/: Rust file engine communicating with the CLI through a JSON Lines protocol.
- native/cow.c: macOS interfaces for cloning, metadata, atomic exchange, and storage attributes.
- tests/: Regression tests for filesystem operations and command behavior.
- scripts/: Validation of real installations, external store reuse, and disk usage on an isolated APFS volume.

## Implementation Constraints

- Preserve the original package manager's version, launcher chain, arguments, working directory, install scripts, and exit status. Let the original tool read and write dependency manifests and lockfiles according to its own rules.
- Do not convert lockfiles, change the project's dependency layout, symlink package directories into a global store, or automatically switch Node.js or package managers.
- External pnpm and Yarn stores are currently read-only sources. Verify actual file contents before reuse. Store unmatched content in DepWeave's own store; do not write external private indexes or trigger their garbage collection.
- Use copy-on-write by default. Report when it is unavailable; do not silently fall back to ordinary copies or general-purpose hardlinks.
- Preserve file contents, paths, and supported metadata. Do not follow dependency-tree symlinks outside the project. Scan installation directories only at the project root and in declared workspace members.
- Replace files atomically and retain recoverable originals. Hash checks and local locks do not guarantee safety against arbitrary external concurrent writes; the dependency tree must remain idle during optimization.
- A dry run must not run an installation or create a store. Skip optimization after an installation failure. An optimization failure must not roll back dependency changes already completed by the original tool.

## Development and Validation

Requirements: Node.js 22+, Rust, and the macOS command line developer tools.

```sh
npm ci
npm run build
npm test
npm run typecheck
cargo clippy --manifest-path native/Cargo.toml --release --locked -- -D warnings
```

Build after changing TypeScript or native code, then run the checks relevant to the change. Add regression tests that verify actual behavior when changing copy-on-write, metadata, project scope detection, command forwarding, or storage formats.

Use npm run validate for real installation and disk usage validation, and npm run validate:providers for modern Yarn and external store validation. See README.md for prerequisites and temporary volume setup. The scripts/ directory defines fixture package manager versions and test data. Do not substitute fake tools for real installation validation.

- Set DEPWEAVE_HOME to a temporary directory for test state, on the same APFS filesystem as the test project.
- Compare lockfiles, installed dependency contents, links, and script behavior between direct and wrapped installations. Verify that modifying one file does not affect other projects or the source store.
- Report shared logical bytes separately from actual reclaimed space. Measure reclaimed space on an isolated volume; neither summed file sizes nor fluctuations on the main disk are evidence of savings.
- After testing, unmount and clean up temporary disk images created by the current task, retaining necessary results and logs. Do not clean up the user's existing volumes or stores.

## Git and Documentation

- Keep package-lock.json, native/Cargo.lock, README.md, and AGENTS.md under version control.
- Keep docs/, .work/, node_modules/, dist/, and native/target/ ignored as local documentation, test data, or build output.
- Do not delete existing local documentation merely because it is ignored.
- Update README.md when features, commands, or support boundaries change. Validation records may be saved in the ignored docs/ directory.
