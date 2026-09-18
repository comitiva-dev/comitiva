# Status

Updated at the end of every phase. The roadmap is in `SPEC.md` §6.

## Current phase: 0 — monorepo, docs, CI, spike

### Done

- **Monorepo**: pnpm 10 workspaces (hoisted), Turborepo, strict shared tsconfig, ESLint (flat, with boundary rules) + Prettier, vitest in every package. Toolchain pins in ADR 0006.
- **`@comitiva/contract`**: zod schemas for every SPEC §3 entity, `Block`, `RunnerRequest`/`RunnerEvent`, `AppError` with stable codes, and the desktop IPC contract. JSON Schema (draft 2020-12) is generated into `packages/contract/schema/` and checked for drift in tests and CI.
- **`@comitiva/runner`**: a JSON-lines runner binary (`dist/bin.cjs`, self-contained) implementing `ping`, `connection.test`, `run.start`, `run.cancel` and `shutdown` for the `anthropic` provider. It streams `run.text_delta`, `run.usage`, `run.done` and `run.error`, with one AbortController per run. `RunnerClient` is exported for shells. A fake Anthropic SSE server is exported from `@comitiva/runner/testing`.
- **`@comitiva/mcp-servers`**: package scaffold only.
- **`apps/desktop`**: electron-vite, React 19, Tailwind 4, Zustand, i18n (en, pt-BR). The window is secure (context isolation, sandbox, CSP, no navigation) with a typed, allowlisted preload. `RunnerSupervisor` spawns the runner in Electron's Node mode and restarts it with backoff. SQLite runs through Drizzle with migration `0000_init`. `ElectronSecretStore` keeps safeStorage blobs in `secrets.bin`, never in SQLite.
- **Spike UI**: an API key field (saved through SecretStore; the key never comes back to the renderer), and two panes that each have Send, Cancel and Reset, streamed output, token usage and event→paint latency.
- **Packaging**: electron-builder config for macOS (dmg, zip), Windows (nsis) and Linux (AppImage, tar.gz). The runner and migrations ship as `extraResources`. Linux was packaged and launched locally.
- **CI**: GitHub Actions runs format check, lint, typecheck, unit/integration tests, the schema drift check, e2e under Xvfb, and an unsigned package build on macOS, Windows and Linux.
- **Docs**: SPEC and design translated to English and synced; architecture.md; ADRs 0001–0006; README; CONTRIBUTING.

### Verification

| Check | Result |
|---|---|
| `pnpm install && pnpm lint && pnpm typecheck && pnpm test` | Green locally and in a fresh clone. 82 tests: contract 21, runner 31, desktop 29, mcp-servers 1. |
| `pnpm --filter desktop test:e2e` | 3/3 green: boot and IPC version, key save and test, two parallel streams with independent cancel. |
| `pnpm dev` | Opens the spike window. The runner starts as a child (`electron …/bin.cjs` in Node mode). |
| `pnpm package` (Linux) | AppImage + tar.gz built. The packaged app starts the runner from `resources/runner/bin.cjs` and reaches `ready`. |
| CI on GitHub | **Not run yet**: the repository has no remote. The workflow was replayed locally (install, format, lint, typecheck, test, schema, e2e). The macOS and Windows package jobs are unverified. |

### Runner event → renderer paint latency

Measured from the runner's `ts` on each `run.text_delta` to just after the next paint in the renderer (rAF + MessageChannel), for the oldest delta in each forwarded batch, so each sample is that batch's worst case. The e2e measures conversation B while A streams at the same time. Fake provider: 80 tokens at 10 ms/token over real HTTP SSE. Linux (Ubuntu 24.04, X11/Wayland), dev build, three runs per setting:

| Main → renderer flush interval | IPC messages (80 tokens) | p50 | p95 | max |
|---|---|---|---|---|
| 0 ms (setTimeout 0) | 80 | 11.8–13.8 ms | 19.2–21.3 ms | 21.5–22.0 ms |
| **16 ms (chosen)** | 39–40 | **21.1–22.0 ms** | **32.5–45.2 ms** | 34.0–51.4 ms |
| 50 ms (design.md's original) | 15–16 | 55.5–57.4 ms | 57.1–75.8 ms | 57.1–75.8 ms |

Reading: the pipeline itself (runner stdout → main → IPC → React commit) adds only a few ms. Most of the 0 ms figure is waiting for the next frame (≤ 16.7 ms). A 16 ms flush halves IPC traffic and keeps p50 around 20 ms, below perception for streaming text. 50 ms is visibly laggier. Decision: **16 ms** (design.md updated).

Real Anthropic key: **pending**. It needs a key pasted into the UI. The spike appends per-run stats to `<userData>/logs/latency.jsonl`; results go here once recorded.

### Deviations from the original design (all reflected in docs/design.md)

1. Drizzle-generated migrations (`0000_init.sql` + `__drizzle_migrations`) instead of a hand-written `0001_init.sql` + `schema_migrations` (ADR 0003).
2. `ping` added to `RunnerRequest`; `run.error` carries `code`; run events carry an optional `ts`.
3. Cancel ends a run with `run.done { stopReason: 'cancelled' }` plus partial usage (estimated when needed), not `run.error`.
4. Deltas are forwarded to the renderer every 16 ms instead of 50 ms (measured above).
5. The runner is bundled into a self-contained `bin.cjs` shipped as `extraResources`. Main bundles `@comitiva/contract` and the `RunnerClient`.
6. `zod-to-json-schema` → zod 4 native `z.toJSONSchema` (ADR 0005). `tool_result.content` is restricted to text/image/document.
7. Runner tests use a real local fake Anthropic SSE server instead of msw (the same server drives the desktop e2e).
8. Desktop tests run under plain Node: better-sqlite3 13 is N-API, so no `electron-rebuild` step.
9. IPC `invoke` resolves to a `{ ok, value | error }` envelope, because custom Error properties do not survive `contextBridge`.
10. Env var `AGENTDESK_RUNNER_LOG` → `COMITIVA_RUNNER_LOG`. Node 24 (matching Electron 44) instead of 22 for development.
11. Temporary `spike.*` IPC channels and `SpikeService` (in-memory history). Replaced by connections/conversations/messages in Phases 1 and 4.
12. Only the dependencies Phase 0 uses are installed. The MCP SDK, OpenAI and Gemini clients, react-markdown and friends come in with their phases.

### Open questions and decisions

- **Google Drive MCP server**: own implementation vs a community one. Deferred to Phase 5b.
- **Linux without a keyring**: the app now refuses to store secrets (safeStorage `basic_text`) unless `COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1`. We need a product decision for Phase 1: keep refusing, or allow obfuscated storage after an explicit, warned user opt-in.
- **Linux dev sandbox**: Ubuntu 24.04+ blocks Chromium's sandbox for unpackaged Electron (AppArmor userns restriction). Dev and e2e use `--no-sandbox` on Linux; see CONTRIBUTING. Packaged builds need the same consideration (setuid `chrome-sandbox`, or an AppArmor profile in the .deb) in Phase 7.
- **Signing and notarization, app icon**: Phase 7. CI builds are unsigned and use the default Electron icon.

## Next: Phase 1 — API connections, secure secrets, connections screen

1. Contract: connection CRUD IPC channels, `ProviderDescriptor`, `listModels` results.
2. Runner: `OpenAICompatibleAdapter`, `GoogleAdapter`, `OllamaAdapter`; `listModels` for all four providers; error mapping per provider.
3. Main: `ConnectionRepository` on Drizzle, `ConnectionService` (secrets through `SecretStore`, only `secretRef` persisted).
4. Renderer: `ConnectionsScreen` and `ConnectionForm` generated from `ProviderDescriptor`. Replace the spike's key field.
5. Done when the four providers test and list models.
