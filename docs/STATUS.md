# Status

Updated at the end of every phase. The roadmap is in `SPEC.md` §6.

## Current phase: 2 — CLI harnesses (Claude Code, Codex), session resume (done)

### Done

- **Research**: both CLIs were checked with `--help` and real recordings on this machine (Claude Code 2.1.278, codex-cli 0.155.1). The flags, line formats, history policy and failure shapes are in `docs/providers.md` → CLI harnesses. Decisions are in ADR 0007.
- **Contract**:
  - `CliConfig` gains `workingDirectory`, and `CodexConfig` adds `sandbox` (`workspace-write` by default, `read-only`, `danger-full-access`).
  - `cliProviderDescriptors` holds the label, binary name, login command, streaming granularity and whether native file tools can be turned off. `providerKind()` and `isCliProviderId()` are new helpers.
  - Drafts and probes accept `claude-code` and `codex`, without a key.
  - New runner request `cli.detect`, plus `run.start.workingDirectory`.
  - New error code `sandbox_unavailable`.
  - New IPC channels `connections.detectBinary` and `dialogs.pickFolder`.
- **Runner** (`providers/cli/`):
  - `CliHarnessAdapter` runs one child process per turn:
    - `locateBinary` checks the explicit path, then PATH, then the usual install dirs.
    - The prompt goes on stdin.
    - stdout is read as JSON lines.
    - The stderr tail is kept for error messages.
    - A turn with no output for 10 min ends with `timeout`.
    - Cancel kills the process group (POSIX) or tree (Windows).
  - History: with `harnessSessionId` the harness resumes the session; without one, the runner replays the history as a transcript. A lost session is retried once as a replay.
  - Env hygiene: `ELECTRON_RUN_AS_NODE`, `COMITIVA_*` and provider keys are dropped.
  - `ClaudeCodeAdapter`: `-p`, stream-json with partial messages, `bypassPermissions`, isolated with `--setting-sources ""` and `--strict-mcp-config`.
  - `CodexAdapter`: `exec [resume] --json`, isolated with `--ignore-user-config`; the sandbox and the role go through `-c`.
  - Pure parsers (`parsers/claudeCode.ts`, `parsers/codex.ts`) produce the session id, text deltas (Codex: one per message), harness tool calls as `tool_use` / `tool_result` blocks (`toolServerId: 'harness:<provider>'`), usage, stop reason and stable error codes.
  - `testConnection` runs these steps: locate → `--version` → auth status → (Codex) `codex sandbox -- true` → a minimal prompt. The errors are actionable: `binary_not_found` with the path, `not_logged_in` with the login command, `sandbox_unavailable`.
  - MCP passthrough is stubbed (`ctx.mcpConfigForCli`, Phase 5).
  - `RunnerClient.detectCli`. `request()` takes `timeoutMs`; CLI connection tests wait up to 120 s.
  - The fake harness (`dist/testing/bin/fake-claude`, `fake-codex`) speaks the recorded formats, with the same kind of prompt controls as the fake API server.
- **Desktop main**:
  - `ConnectionService` handles CLI drafts and probes (`kind` from the provider, and no key is ever read or stored for them) and adds `detectBinary`.
  - IPC handlers for `connections.detectBinary` and `dialogs.pickFolder`.
  - `resolveWorkingDirectory()` gives the connection's directory, else `<userData>/workspaces/<conversationId>`. It is ready for `ConversationService` in Phase 4.
- **Renderer**:
  - The provider picker has an API services group and a CLI harnesses group.
  - `CliConnectionForm` has these fields:
    - binary path with **Detect** (fills in the path, shows the version)
    - working directory with **Choose…** (blank means one folder per conversation)
    - Codex sandbox, with help text for each option
    - default model (free text)
    - extra args, one per line
  - An always-visible notice explains auto-accept. Codex also carries a warning that its own file edits bypass Comitiva's approvals, and a note that it streams one message at a time.
  - A failed test shows the error by code plus a hint (the login command, the sandbox, the binary).
  - `FormShell` is shared with the API form. The list shows CLI rows with monograms (CC, Cx). Strings are in en and pt-BR.

### History per harness

| Harness | Kept by | How |
|---|---|---|
| Claude Code | the harness | `--resume <session_id>` (from `system/init`); only the new message is sent |
| Codex | the harness | `codex exec resume <thread_id> -` (from `thread.started`); only the new message is sent |
| Either, without a session (first turn, moved conversation, lost session) | Comitiva | the earlier messages are replayed as a transcript prompt, and a new session starts |

### Verification

| Check | Result |
|---|---|
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | Green. 285 tests: contract 31, runner 188, desktop 65, mcp-servers 1. |
| Parsers vs. recorded fixtures | 16 tests over 12 real recordings: simple turn, resume with a tool, thinking, long stream, not logged in, lost session (Claude); simple turn, resume, shell and file-change tools, sandbox failure, 401 retries, bad model, lost thread (Codex). |
| Process wrapper and lookup | Line order (split and unterminated lines), stderr tail, exit codes, idle timeout, abort kills a grandchild (process group), missing binary, PATH before install dirs. |
| Adapters vs. fake harness | Both harnesses: first turn in a new cwd with a clean env, resume sends only the new message, replay without a session, retry after a lost session, tool blocks, cancel mid-stream (estimated usage + `done(cancelled)`), not logged in, early exit with stderr, the connection's working directory, detect, test ok and its errors. Exact argv for both. Codex sandbox probe. |
| Runner binary (`bin.cjs`, spawned) | Both harnesses through `RunnerClient`: `cli.detect` (found and missing), `connection.test`, a streamed turn with `run.session`, a resumed turn, and a turn cancelled mid-stream. |
| `pnpm --filter desktop test:e2e` | 13/13 green (10 Phase 1 + 3 new): Claude Code detected on PATH, tested and saved; Codex with a sandbox, the native-tools warning, a relative working directory refused, tested in the form and from the list, and edit keeps the settings; a missing binary and a missing login (hint shows `claude auth login`). |
| **Real CLIs**, by hand through `node packages/runner/dist/bin.cjs` | **Claude Code 2.1.278**: detect → `/home/…/.local/bin/claude`. Test ok (2.3 s). A turn streamed with exact usage and `end_turn`. The resumed turn remembered the first ("Mango" / "Mango"). Cancel after 2 deltas → `done(cancelled)`, estimated usage, no process left. **Codex 0.155.1**: detect ok. Test ok (3.8 s, full access). A turn, then a resumed turn that remembered it. Cancel mid-turn → `done(cancelled)` 0.3 s later, no process left. **Errors**: an empty `CLAUDE_CONFIG_DIR` / `CODEX_HOME` → `not_logged_in` with the login command; Codex `workspace-write` on this Ubuntu 24.04 → `sandbox_unavailable` ("bwrap: loopback: Failed RTM_NEWADDR"); a wrong path → `binary_not_found` "Claude Code not found at /opt/nope/claude". |
| UI with the real CLIs | **Not done.** The UI path was verified with the fake binaries (e2e); the real binaries were verified through the runner. |

### Deviations from the plan and design (all reflected in docs/design.md)

1. CLI descriptors live in a separate `cliProviderDescriptors` map, so the API `providerDescriptors` keeps its exact typed shape.
2. `streamTurn`, `UsageTracker` and `httpError` stay in `providers/api/shared.ts`, and the CLI adapters import them from there. The plan had moved them to `providers/shared/`.
3. The fake harness generates lines in the recorded formats instead of replaying the fixture files, so `dist/testing` has no dependency on `test/`. The parsers are tested against the real recordings.
4. `fakeHarnessBinaries(runnerPackageDir)` takes the package directory, because Playwright loads `@comitiva/runner/testing` as CommonJS (no `import.meta`).
5. The Claude Code login command is `claude auth login` (what 2.1.278 has), not `claude login`.
6. Working directories are resolved in main, but no run uses them from the app yet: chat arrives in Phase 4. The runner path is covered by tests.
7. CLI connections need no model: without one, the harness uses its default (`--model` / `-m` are omitted).
8. A relative working directory or binary path is refused in the form; `~` is not expanded for working directories.

### Decisions

- **Codex streaming**: `exec --json`, one message at a time. The experimental `app-server` gets revisited when it is stable.
- **Native tools until Phase 5**: kept, with auto-accept, and explained in the form.
- **Codex sandbox**: per connection, `workspace-write` by default. testConnection detects a sandbox that cannot start.
- **Isolation**: harnesses do not load the user's CLI settings or MCP servers; `extraArgs` can override that.

### Open

- **Windows**: spawning `.cmd` shims and `taskkill /T` are implemented but not run on Windows. The fake harness is a POSIX script, so the CLI e2e is skipped there. The Codex sandbox probe on macOS is not verified either.
- **Codex native writes**: `apply_patch` cannot be turned off, so Codex writes will never go through Comitiva's approvals. Phase 5 decides whether Codex only ever gets `read-only` when the agent has a `filesystem` server.
- A harness that ignores SIGTERM is killed 3 s later; a runner crash mid-turn can orphan a harness. Revisit with the Phase 4 chat.
- Carried over: real API provider check (Phase 1), CI on GitHub (no remote), Google Drive server choice (5b), Linux sandbox/signing/icon (Phase 7).

## Next: Phase 3 — Agents: CRUD, role, model, avatar

1. Contract: agent IPC (`agents.list | create | update | delete | duplicate`), with model picking per connection (API: `listModels`; CLI: free text or the harness default).
2. Main: `AgentRepository` (with roots and tool servers loaded together) and `AgentService`; `connection_in_use` already guards deletes.
3. Renderer: an agent form (name, avatar, connection, model, role, params) and agents in the sidebar.
4. Done when an agent shows up in the sidebar.

## Phase 1 — API connections, secure secrets, Connections screen (done)

#### Done

- **Contract**:
  - `providerDescriptors` (`providers.ts`) is static data per API provider: capabilities, key requirement, base URL mode and default, and presets for OpenAI-compatible (OpenAI, OpenRouter, Groq, LM Studio, custom). The runner adapters take their `capabilities` from it, and the renderer builds the form from it.
  - Connection IPC: `ConnectionDraft`, `ConnectionProbe`, `ConnectionPatch`, `ConnectionTarget` and `ConnectionSummary` (`{ connection, hasSecret, lastTest }`), plus `SecretStorageStatus`.
  - Channels `connections.list | create | update | delete | test | listModels` and `secrets.getStatus`. The `spike.*` channels are gone.
  - New error codes: `connection_in_use`, `not_found`.
  - `GoogleConfig.baseUrl` (optional) and `OpenAICompatibleConfig.preset` (a UI hint).
- **Runner**:
  - `createDefaultRegistry()` registers four adapters:
    - `AnthropicAdapter` (finished: `listModels`)
    - `OpenAICompatibleAdapter` (openai SDK)
    - `GoogleAdapter` (`@google/genai`, Gemini API keys)
    - `OllamaAdapter` (fetch, NDJSON)
  - Each adapter implements `testConnection`, `listModels` and a streamed `run` with usage and error mapping.
  - The shared rules live in `providers/api/shared.ts`:
    - status → code mapping with `retryable`
    - network errors → `provider_unavailable` or `timeout`
    - a 15 s deadline for probes
    - usage reported by the provider or estimated
    - cancel that always ends with usage plus `done(cancelled)`, even if an SDK ignores the abort
  - SDKs get explicit keys and endpoints, so ambient `*_API_KEY` / `*_BASE_URL` env vars are never used.
  - `connection.listModels` works over the protocol. `RunnerClient.listModels` was added, and `testConnection` now validates its result.
  - Tools and images are not wired yet: non-Anthropic adapters reject non-text blocks with `unsupported_content`.
- **Desktop main**:
  - `ConnectionRepository` (Drizzle): config is validated on read and write, and only `secret_ref` is stored. Migration `0001` adds the `last_test_*` columns. Deletes are refused while agents use the connection.
  - `ConnectionService`: keys go to the SecretStore under `connection:<id>`, and validation runs before any key is written. Test and list models work for a saved id, unsaved settings, or both (reusing the stored key). Tests of saved connections are recorded, and the last test is cleared when config or key change.
  - `ElectronSecretStore.status()`, and the refusal on a keyring-less Linux (below).
- **Renderer**:
  - App shell: the sidebar has an Agents placeholder, Connections, and Tools / Usage / Settings placeholders, plus version and runner status.
  - Connections screen, one row per connection:
    - a provider monogram badge
    - name, provider or preset, default model
    - an enabled toggle
    - the last test (latency and relative time, or the error text by code)
    - Test, Edit, and Delete with an in-app confirmation
  - Create/edit form:
    - it adapts to the provider and preset
    - the key field is masked, never prefilled, with "remove key"
    - base URL is always shown for Ollama and OpenAI-compatible, and advanced for Anthropic and Gemini
    - default model has a datalist, and "Fetch models" picks the first model when none is set
    - Test shows latency or the error by code
  - Banner when keys cannot be stored. Strings in en and pt-BR. Light and dark via `prefers-color-scheme`.
- **Docs**: `docs/providers.md` (how to add an adapter). design.md, architecture.md, SPEC §7, CLAUDE.md and README are synced.

#### Verification

| Check | Result |
|---|---|
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | Green. 205 tests: contract 27, runner 126, desktop 51, mcp-servers 1. |
| Runner adapters (msw) | A shared conformance suite runs for each of the four adapters. It covers delta order, exact and estimated usage, the max-tokens stop, cancel mid-stream (request closed), 401/403/429/500/503/404 on run, test and listModels, a real refused connection, model parsing, test latency, and ambient env credentials being ignored. Provider-specific tests cover body mapping, cache and thinking tokens, keyless OpenAI-compatible (no `Authorization`), the OpenAI preset's `max_completion_tokens`, Gemini `API_KEY_INVALID`, Ollama error lines and an unterminated last line. |
| Runner binary (`bin.cjs`, spawned) | For each provider against `startFakeProviders`: test (ok and `bad-key` → `auth_failed`), listModels, and a streamed run with exact usage. Also four parallel runs, one per provider, with Ollama cancelled while the other three finish. |
| `pnpm --filter desktop test:e2e` | 10/10 green: boot and shell navigation; create, fetch models, test, save and list test for all four providers; rejected key shown by code; rename keeps the stored key (the fake server saw it); enabled toggle and last test survive a reload; delete confirmation; no key in `comitiva.db*` or `secrets.bin`. |
| By hand | `connection.listModels` and `connection.test` (refused port → `provider_unavailable`, retryable) through `node packages/runner/dist/bin.cjs`. Screenshots of the list and form checked (`apps/desktop/test-results/`). |
| Real provider | **Not verified.** No API key was provided, and neither Ollama nor LM Studio is installed on the dev machine. Everything above runs against msw and the local fake server. Next step: run test, listModels and a short streamed run with a real key per provider, and record the result here. |

#### Deviations from the plan and design (all reflected in docs/design.md)

1. Provider form metadata lives in `@comitiva/contract` (`providerDescriptors`), not in `ProviderRegistry.list()`, so the UI does not need a runner round trip. `ProviderRegistry.list()` returns `{ id, kind, capabilities }`.
2. Adapter unit tests use msw (conformance suite), as asked for this phase. The real fake server was kept and extended to all four providers (`startFakeProviders`; `startFakeAnthropic` is a deprecated alias), because msw cannot reach the spawned runner or the e2e app.
3. `connections.test` and `connections.listModels` accept a `ConnectionTarget` (`{ id }`, `{ probe }` or both), not just an id, so the form can test and fetch models before saving.
4. Only tests of saved connections are recorded (`last_test_*` columns). Probes from the form are not.
5. UI navigation state (`section`) lives in the app store instead of a separate `ui.ts`.
6. Provider icons are monogram badges, not brand logos (no trademark assets in the repo).
7. The Phase 0 spike was deleted. Parallel streaming and cancel stay covered at the runner level; the UI-level streaming e2e returns with chat in Phase 4. `COMITIVA_ANTHROPIC_BASE_URL`, `COMITIVA_DELTA_FLUSH_MS` and `logs/latency.jsonl` went with it.

#### Decisions

- **Linux without a keyring**: refuse. `ElectronSecretStore` rejects the `basic_text` backend (`secret_store_unavailable`), and the Connections screen shows a banner explaining how to install or unlock GNOME Keyring or KWallet. Keyless connections (Ollama, LM Studio) keep working. `COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1` stays for tests and CI only. Recorded in SPEC §7.

#### Open

- **Real-provider check** (above).
- **CI on GitHub**: still no remote; the workflow runs the same commands, and `test:e2e` now runs the connections e2e.
- Carried over from Phase 0: Google Drive server choice (5b); Linux sandbox for packaged builds, signing and icon (Phase 7).

## Phase 0 — monorepo, docs, CI, spike (done)

#### Done

(The spike UI, `SpikeService`, `spike.*` IPC and the spike e2e were removed in Phase 1.)

- **Monorepo**: pnpm 10 workspaces (hoisted), Turborepo, strict shared tsconfig, ESLint (flat, with boundary rules) + Prettier, vitest in every package. Toolchain pins in ADR 0006.
- **`@comitiva/contract`**: zod schemas for every SPEC §3 entity, `Block`, `RunnerRequest`/`RunnerEvent`, `AppError` with stable codes, and the desktop IPC contract. JSON Schema (draft 2020-12) is generated into `packages/contract/schema/` and checked for drift in tests and CI.
- **`@comitiva/runner`**: a JSON-lines runner binary (`dist/bin.cjs`, self-contained) implementing `ping`, `connection.test`, `run.start`, `run.cancel` and `shutdown` for the `anthropic` provider. It streams `run.text_delta`, `run.usage`, `run.done` and `run.error`, with one AbortController per run. `RunnerClient` is exported for shells. A fake Anthropic SSE server is exported from `@comitiva/runner/testing`.
- **`@comitiva/mcp-servers`**: package scaffold only.
- **`apps/desktop`**: electron-vite, React 19, Tailwind 4, Zustand, i18n (en, pt-BR). The window is secure (context isolation, sandbox, CSP, no navigation) with a typed, allowlisted preload. `RunnerSupervisor` spawns the runner in Electron's Node mode and restarts it with backoff. SQLite runs through Drizzle with migration `0000_init`. `ElectronSecretStore` keeps safeStorage blobs in `secrets.bin`, never in SQLite.
- **Spike UI**: an API key field (saved through SecretStore; the key never comes back to the renderer), and two panes that each have Send, Cancel and Reset, streamed output, token usage and event→paint latency.
- **Packaging**: electron-builder config for macOS (dmg, zip), Windows (nsis) and Linux (AppImage, tar.gz). The runner and migrations ship as `extraResources`. Linux was packaged and launched locally.
- **CI**: GitHub Actions runs format check, lint, typecheck, unit/integration tests, the schema drift check, e2e under Xvfb, and an unsigned package build on macOS, Windows and Linux.
- **Docs**: SPEC and design translated to English and synced; architecture.md; ADRs 0001–0006; README; CONTRIBUTING.

#### Verification

| Check | Result |
|---|---|
| `pnpm install && pnpm lint && pnpm typecheck && pnpm test` | Green locally and in a fresh clone. 83 tests: contract 21, runner 31, desktop 30, mcp-servers 1. |
| `pnpm --filter desktop test:e2e` | 3/3 green: boot and IPC version, key save and test, two parallel streams with independent cancel. |
| `pnpm dev` | Opens the spike window. The runner starts as a child (`electron …/bin.cjs` in Node mode). |
| `pnpm package` (Linux) | AppImage + tar.gz built. The packaged app starts the runner from `resources/runner/bin.cjs` and reaches `ready`. |
| CI on GitHub | **Not run yet**: the repository has no remote. The workflow was replayed locally (install, format, lint, typecheck, test, schema, e2e). The macOS and Windows package jobs are unverified. |

#### Runner event → renderer paint latency

Measured from the runner's `ts` on each `run.text_delta` to just after the next paint in the renderer (rAF + MessageChannel), for the oldest delta in each forwarded batch, so each sample is that batch's worst case. The e2e measures conversation B while A streams at the same time. Fake provider: 80 tokens at 10 ms/token over real HTTP SSE. Linux (Ubuntu 24.04, X11/Wayland), dev build, three runs per setting:

| Main → renderer flush interval | IPC messages (80 tokens) | p50 | p95 | max |
|---|---|---|---|---|
| 0 ms (setTimeout 0) | 80 | 11.8–13.8 ms | 19.2–21.3 ms | 21.5–22.0 ms |
| **16 ms (chosen)** | 39–40 | **21.1–22.0 ms** | **32.5–45.2 ms** | 34.0–51.4 ms |
| 50 ms (design.md's original) | 15–16 | 55.5–57.4 ms | 57.1–75.8 ms | 57.1–75.8 ms |
| 16 ms, 200 tokens, 8 CPU-bound busy loops in parallel | ~98 | 20.9–22.1 ms | 35.7–40.9 ms | 52.1–56.0 ms |

Reading: the pipeline itself (runner stdout → main → IPC → React commit) adds only a few ms. Most of the 0 ms figure is waiting for the next frame (≤ 16.7 ms). A 16 ms flush halves IPC traffic and keeps p50 around 20 ms, below perception for streaming text. 50 ms is visibly laggier. Decision: **16 ms** (design.md updated).

Real Anthropic key: **pending**. It needs a key pasted into the UI. The spike appends per-run stats to `<userData>/logs/latency.jsonl`; results go here once recorded.

#### Deviations from the original design (all reflected in docs/design.md)

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

#### Open questions and decisions

- **Google Drive MCP server**: own implementation vs a community one. Deferred to Phase 5b.
- **Linux without a keyring**: the app now refuses to store secrets (safeStorage `basic_text`) unless `COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1`. We need a product decision for Phase 1: keep refusing, or allow obfuscated storage after an explicit, warned user opt-in.
- **Linux dev sandbox**: Ubuntu 24.04+ blocks Chromium's sandbox for unpackaged Electron (AppArmor userns restriction). Dev and e2e use `--no-sandbox` on Linux; see CONTRIBUTING. Packaged builds need the same consideration (setuid `chrome-sandbox`, or an AppArmor profile in the .deb) in Phase 7.
- **Race fixed during verification**: the renderer could miss the runner's `ready` if the status broadcast arrived while `init()` was fetching the status. Pushed status now wins, with a regression test.
- **Signing and notarization, app icon**: Phase 7. CI builds are unsigned and use the default Electron icon.
