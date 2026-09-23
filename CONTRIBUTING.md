# Contributing to Comitiva

Thanks for helping. This guide covers setup, the rules the codebase relies on, and how to send changes.

## Setup

- Node 24 (`.nvmrc`). The packages support Node ≥ 22, but the app runs on Electron 44's Node 24.
- pnpm 10 through corepack: `corepack enable` (the version is pinned in `package.json`).
- Build tools for native modules: Xcode Command Line Tools (macOS), Visual Studio Build Tools (Windows), or `build-essential` + Python 3 (Linux).

```bash
pnpm install
pnpm dev
```

### Linux: Chromium sandbox on Ubuntu 24.04+

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, so an unpackaged Electron aborts with `The SUID sandbox helper binary was found, but is not configured correctly`. Pick one:

- Run without the OS sandbox in development: `pnpm dev -- --noSandbox`. The e2e suite already passes `--no-sandbox` on Linux.
- Or make the dev sandbox helper setuid (redo after reinstalling Electron):
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
- Or allow user namespaces system-wide (less strict): `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

### Linux: secret storage

Secrets are encrypted with Electron `safeStorage`, which needs a running keyring (GNOME Keyring or KWallet). Without one, the app refuses to save secrets. Tests set `COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1` to allow obfuscated storage; don't use it for real keys.

## Before you code

1. Read `SPEC.md`, `docs/design.md` and `docs/architecture.md`.
2. For anything that changes behavior across packages, open an issue or write an ADR in `docs/adr/` first.
3. Work in this order inside a feature: **contract → runner → main → renderer**, with tests at each layer.

## Rules the codebase relies on

- `packages/runner` and `packages/mcp-servers` must not depend on Electron.
- Secret values never go into SQLite, renderer IPC payloads or logs; only `secretRef`s do.
- The renderer talks only to the `Backend` interface. `window.api` appears only in `LocalBackend.ts`.
- Errors carry stable `AppError` codes; the UI translates codes and never uses raw provider messages as titles.
- UI strings go through i18n: add keys to both `en.json` and `pt-BR.json`.
- Code, comments, commits and docs are in English.

ESLint enforces the dependency boundaries.

## Checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm --filter desktop test:e2e
pnpm package && pnpm --filter desktop test:packaged   # when you touch packaging or paths
```

More on tests, debugging and packaging in [docs/development.md](docs/development.md).

If you change the contract, run `pnpm contract:schema` and commit `packages/contract/schema/`. If you change the DB schema, run `pnpm --filter desktop db:generate` and commit the migration.

## Commits and pull requests

- Conventional commits with the package as scope: `feat(runner): …`, `fix(desktop): …`, `docs: …`, `ci: …`.
- Keep commits small and focused; keep `docs/design.md` in sync in the same commit when you deviate from it.
- PRs must pass CI (lint, typecheck, tests, e2e, and packaging plus a smoke test of the packaged app on three OSes).
- Releases are cut by maintainers from tags; the process is in [docs/development.md](docs/development.md#releasing).

## Roadmap

v0.1.0 closes the desktop phases. What comes next, by phase ([SPEC.md §6](SPEC.md#6-roadmap)):

| Phase | Deliverable | Done when |
|---|---|---|
| 8 | Laravel hub: auth, workspaces, sync of agents and conversations, Reverb, a `RemoteBackend` in the desktop | Two desktops see the same conversation live |
| 9 | Web: the same UI served by the hub, API and `http` MCP execution in the hub, team keys; a desktop as the workspace runner | A user without the desktop talks to a team API agent |
| 10 | Usage policies: limits, concurrency, fallback and connection switching | An agent switches connection when it hits a limit |

Known gaps you can pick up (see [docs/STATUS.md](docs/STATUS.md) for the details):

- **Code signing and notarization** for macOS and Windows (the release workflow is ready for the secrets; [docs/development.md](docs/development.md#code-signing-to-do)).
- **A real app icon** (`apps/desktop/build/icon.svg` is a placeholder).
- Revoking "Always allow" decisions from the UI.
- Images in tool results for providers other than Anthropic, and PDFs as attachments.
- MCP `tools/list_changed` notifications.
- A Gemini CLI harness (`gemini-cli` is in the contract, without an adapter).
- Hand-run checks against real providers, the real CLIs and a real Google account, on Windows and macOS too.

Good first issues: translations (add a locale next to `en.json` and `pt-BR.json`), provider presets for more OpenAI-compatible endpoints, MCP server examples in [docs/tools.md](docs/tools.md).

## License

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.
