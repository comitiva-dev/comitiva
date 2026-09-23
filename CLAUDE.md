# Comitiva

Agentic chat for your whole team. Open source desktop app (Electron + TypeScript) where users register LLM connections (APIs or CLI harnesses such as Claude Code and Codex), create agents with a role and a set of tools (local folders, Google Drive, any MCP server), and talk to all of them in a Slack-style chat with many conversations running in parallel. Later: a Laravel hub for teams and a web UI.

## Read first

- `SPEC.md` — what the product is, domain model, architecture, roadmap by phase. Source of truth.
- `docs/design.md` — how it is built: file layout, package names, data model, classes and methods, runner protocol, flows, commands. Follow it unless there is a reason to deviate; if you deviate, say so and update it in the same commit.
- `docs/architecture.md` — processes, runner protocol, boundaries, data locations.
- `docs/providers.md` — how to add a provider adapter (rules, shared helpers, conformance tests).
- `docs/tools.md` — tools, roots, the permission gate and approvals, the CLI MCP proxy, Google Drive (OAuth client setup), adding MCP servers.
- `docs/usage.md` — how usage is recorded and costed, the pricing table, price corrections, the reports.
- `docs/STATUS.md` — what is done and what is next. Update at the end of every phase.
- `docs/adr/` — one file per decision that affects more than one package.

## Layout

```
packages/contract     @comitiva/contract    zod schemas + generated JSON Schema (schema/*.json, committed)
packages/runner       @comitiva/runner      JSON-lines runner process (dist/bin.cjs, dist/mcp-proxy.cjs) + RunnerClient
                                            + usage/ (pricing.json, UsageCalculator, Tokenizer) + testing/ fakes
packages/mcp-servers  @comitiva/mcp-servers built-in MCP servers (dist/filesystem.cjs, dist/google-drive.cjs) + testing/ fake Google
apps/desktop          desktop               Electron: main (SQLite, SecretStore, RunnerSupervisor, IPC), preload, renderer
```

## Non-negotiable rules

- `packages/runner` and `packages/mcp-servers` have zero Electron dependencies. They are plain Node processes with a JSON-lines protocol. (ESLint enforces it.)
- Secrets never touch SQLite, IPC payloads to the renderer, or logs. Only `secretRef` travels; values go to the runner per request and are not persisted there.
- The renderer depends only on the `Backend` interface, never on IPC or the runner directly. (ESLint enforces it; `window.api` is used only in `backend/LocalBackend.ts`.)
- The filesystem MCP server rejects any path outside the agent's roots at the server level, including symlink escapes.
- Implementation order inside a phase: contract → runner → main → renderer, with tests at each layer before the next. A topic is done only when an integration or e2e test exercises the whole path.
- Nothing in the core assumes code, Git or terminals. Comitiva is generic.

## Conventions

- TypeScript strict (TS 6.0), pnpm 10 workspaces (hoisted), Turborepo. Package names `@comitiva/*`. Toolchain pins and why: ADR 0006.
- Conventional commits with package scope: `feat(runner): ...`, `fix(desktop): ...`, `docs: ...`. Small commits.
- Errors carry stable codes (`AppError` in contract); the UI translates by code and never shows raw provider messages as titles.
- `run.usage`'s `inputTokens` is always net of `cacheReadTokens`. Providers disagree; adapters normalize. Prices are read off the providers' pages, never from memory, and `pricing.json` records the date and the URLs.
- Code, comments, commits and docs in English. UI strings go through i18n (`renderer/src/i18n/en.json`, `pt-BR.json`); main's strings (menu, dialogs) live there too, under `main.*` (command labels under `commands.*`, shared with the shortcuts dialog). ESLint rejects literal JSX text and prose in `placeholder`/`title`/`alt`/`aria-label`; a test checks both locales have the same keys and `{{variables}}`.
- Contract changes: edit zod in `packages/contract/src`, run `pnpm contract:schema`, commit the JSON. New IPC channels also go in `ipc-channels.ts` (a test checks it).
- DB changes: edit `apps/desktop/src/main/db/schema.ts`, run `pnpm --filter desktop db:generate`, commit the migration.
- Plan before coding. When something is ambiguous, ask instead of guessing product decisions.

## Commands

```bash
pnpm install                        # pnpm 10 via corepack (packageManager field)
pnpm dev                            # desktop in dev; on Ubuntu 24.04+: pnpm dev -- --noSandbox
pnpm build                          # all packages (turbo, dependency order)
pnpm lint | pnpm typecheck | pnpm test | pnpm format:check
pnpm --filter desktop test:e2e      # builds the app and runs Playwright against the fake four-provider server
pnpm contract:schema                # regenerate packages/contract/schema/*.json (commit it)
pnpm --filter desktop db:generate   # generate a Drizzle migration from schema.ts
pnpm package                        # electron-builder for the current platform → apps/desktop/release/
pnpm --filter desktop test:packaged # smoke-test the packaged app (after pnpm package)
pnpm changelog                      # release notes since the last tag (--prepend CHANGELOG.md to write them)
echo '{"id":"1","type":"ping"}' | node packages/runner/dist/bin.cjs   # talk to the runner by hand
```

Env vars: `COMITIVA_RUNNER_LOG` (runner log level, stderr → `<userData>/logs/runner.log`), `COMITIVA_USER_DATA` (override userData), `COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1` (tests/CI only: allow Linux `basic_text`; without it the app refuses to store keys on a keyring-less Linux), `COMITIVA_GOOGLE_OAUTH_BASE_URL` / `COMITIVA_GOOGLE_API_BASE_URL` (tests/CI only: point Google OAuth and the Drive API at the fake server), `COMITIVA_DISABLE_UPDATES=1` (never check for updates), `COMITIVA_UPDATE_FEED_URL` (tests only: a local update feed).

More detail: `docs/design.md` §8.
