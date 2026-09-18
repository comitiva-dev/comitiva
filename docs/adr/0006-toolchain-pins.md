# 0006 — Toolchain pins

- Status: Accepted
- Date: 2026-09-18

## Context

Several tools had just released majors that do not yet work with the rest of the stack. We found this while bootstrapping Phase 0.

## Decision

| Tool | Pinned | Why not latest |
|---|---|---|
| pnpm | 10.34.5 (`packageManager`) | pnpm 12 ignored `nodeLinker: hoisted` and skipped native build scripts on a fresh install. |
| TypeScript | ~6.0 | typescript-eslint 8 supports `<6.1`. TS 7 (native) is not yet supported by the lint toolchain. |
| Vite | ^7 | electron-vite 5 supports Vite ≤ 7. |
| @vitejs/plugin-react | ^5 | v6 requires Vite 8. |
| Node | 24 (`.nvmrc`) | Matches the Node inside Electron 44, which runs the runner in the app. The runner still supports Node ≥ 22. |
| Electron | 44.4.2, exact | electron-builder requires an exact version. |

Package declarations are emitted with `tsc` (not tsup's `dts`), because tsup's DTS build sets `baseUrl`, which TS 6 rejects.

pnpm settings live in `pnpm-workspace.yaml` (hoisted linker, allowed build scripts). Turborepo runs in `envMode: loose`, because strict mode hid `DBUS_SESSION_BUS_ADDRESS` from `pnpm dev` and broke Linux `safeStorage`.

## Consequences

Revisit when electron-vite supports Vite 8 and typescript-eslint supports TS 7. Each bump is its own `build:` commit that updates this ADR.
