# 0002 — Run the runner as Electron in Node mode

- Status: Accepted
- Date: 2026-09-18

## Context

The runner (`packages/runner`) is a plain Node process that owns all LLM execution and talks JSON lines over stdin/stdout (SPEC §4.1). The desktop needs a Node runtime to spawn it. Options from SPEC §7:

1. **Electron in Node mode**: spawn `process.execPath` (the app's own Electron binary) with `ELECTRON_RUN_AS_NODE=1`.
2. **Bundled node binary**: ship a pinned Node binary per platform in `extraResources`.

Electron's `utilityProcess` was also considered. It cannot give the child a stdin pipe (stdout/stderr only, plus MessagePort), so it would break the stdio JSON-lines protocol that other shells (CLI, NativePHP, a server) rely on.

## Decision

Spawn the runner with **`process.execPath` and `ELECTRON_RUN_AS_NODE=1`** (`RunnerSupervisor`). The runner is bundled by tsup into one self-contained `bin.cjs` (all dependencies inlined) and shipped as `extraResources/runner/bin.cjs`, outside the asar.

## Consequences

- No extra 40–90 MB binary per platform, no per-OS download or signing step, one toolchain.
- The runner runs on Electron's Node version (Electron 44 → Node 24.21). The runner still supports any Node ≥ 22 when run standalone (`node bin.cjs`).
- The **RunAsNode fuse must stay enabled**. With it on, anyone who can run the app binary can use it as a Node interpreter. That is no more than a local user can already do, but it does rule out the "disable RunAsNode" hardening step. If we later want that hardening, we switch to option 2; the protocol and `RunnerClient` do not change.
- The runner inherits the app's code signature on macOS, so no separate notarization.
- Verified in Phase 0: in dev (`pnpm dev`), in the packaged Linux build (`release/linux-unpacked`), and in tests (which spawn the same `bin.cjs` with plain Node).
