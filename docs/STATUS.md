# Status

Updated at the end of every phase. The roadmap is in `SPEC.md` §6.

## Current phase: 5b — Google Drive and third-party servers (done)

Done when an agent reads a Google Doc and creates another one with approval: yes. The first test of `e2e/google-drive.spec.ts` covers it through the built app, against a fake Google (OAuth plus a Drive API subset):

- The OAuth client is set up and the account connected from the Tools screen. `shell.openExternal` stands in for the browser.
- The agent searches and reads the Doc on its own.
- `create` waits on the approval card, which shows `name: Launch summary`.
- After **Allow**, the fake Drive holds the new Google Doc with the Markdown content.

**Not verified yet** against a real Google account: that needs the user's own OAuth client (below).

### Done

- **Decision (made with the user before implementing), ADR 0010:**
  - We write our own server; the maintained community ones run their own OAuth, keep tokens in files under `~/.config`, and have 100+ tools.
  - The scope is the full `drive` scope, and the user brings their own OAuth client ("Desktop app"). The client ID and secret are entered on the Drive row of the Tools screen.
  - One Google account per app.
- **Contract:**
  - `BuiltinToolServer` gains `google-drive`, and `GOOGLE_DRIVE_TOOL_SERVER_ID` is new.
  - `ToolDef` gains `title`, plus the `idempotentHint` and `openWorldHint` annotations (`ToolAnnotations`).
  - `toolServers.test` takes `ToolServerTestTarget` (`{ id } | { spec, id? }`).
  - New channels `googleDrive.getStatus | configure | connect | cancelConnect | disconnect`, with `GoogleDriveStatus` (no token or secret, only `hasClientSecret` and the email).
  - New error codes `oauth_not_configured`, `oauth_failed`, `oauth_cancelled`, `google_not_connected` and `google_reconnect_required`.
- **mcp-servers:**
  - `google-drive` (`dist/google-drive.cjs`, bin `comitiva-mcp-gdrive`), with five tools:
    - `search` (text, type, folder, pages)
    - `read`: Docs as Markdown, Sheets as CSV (first sheet), Slides as text, text files up to 1 MB (Range beyond), images up to 5 MB
    - `create`: a Doc from Markdown, a Sheet from CSV, a text file, or a folder
    - `update`: replace content and/or rename
    - `move`
  - The tools are annotated, and the write tools exist only with `--gated-by-client`. Shared drives are included.
  - The token comes from `GDRIVE_ACCESS_TOKEN` only, and is removed from `process.env` once read.
  - `DriveApi` is a small fetch client, with no `googleapis`. HTTP errors map to stable codes.
  - `startFakeGoogle` (`@comitiva/mcp-servers/testing`) is a real HTTP server. It fakes:
    - OAuth: client, secret, redirect URI, single-use codes, PKCE S256, refresh, `invalid_grant`, revoke
    - Drive v3: files in memory, a small query language, export, multipart and media uploads, parents, `about`, scripted failures
- **Runner:**
  - The `google-drive` built-in gets `--gated-by-client` and the `gdrive__` prefix.
  - Idle built-in instances close after 10 min (`FILESYSTEM_IDLE_MS` → `BUILTIN_IDLE_MS`).
  - `toToolDef` keeps the title and all four hints.
- **Desktop main:**
  - `oauth/GoogleOAuth.ts` is free of Electron imports. It covers:
    - the loopback listener on `127.0.0.1:0`, which takes one request with the right `state` and ignores the rest
    - PKCE S256, `access_type=offline` and `prompt=consent`
    - a check that the scope was granted
    - a 5 min timeout, and cancel
    - refresh (`invalid_grant` → `google_reconnect_required`) and best-effort revoke
    - a static, script-free page for the browser tab
  - `GoogleDriveService`:
    - The client and tokens live in the SecretStore (`google:oauthClient`, `google:tokens`).
    - `connect`: one attempt at a time; it fetches the email; it stops the old server.
    - `accessToken()` refreshes when fewer than 15 min are left, single-flight, and remembers `reconnect_required`.
    - `disconnect` revokes and forgets. A new client ID disconnects.
  - `ToolServerService` launches Drive with the bundled server, `ELECTRON_RUN_AS_NODE` and a fresh `GDRIVE_ACCESS_TOKEN` per launch. It tests unsaved settings under a throwaway id and stops them afterwards; `keepSecret` reads the stored secret.
  - Migration `0005_google_drive_tool_server` seeds the built-in (custom SQL). `paths.googleDriveServer()`, and packaging ships `mcp-servers/google-drive.cjs`.
  - `COMITIVA_GOOGLE_OAUTH_BASE_URL` and `COMITIVA_GOOGLE_API_BASE_URL` point at a fake, for tests only.
- **Renderer:**
  - `Backend.googleDrive`, the `googleDrive` store, and `toolServers.probe` / `clearTest`.
  - Tools screen, Google Drive row. The account shows one of:
    - not set up
    - not connected
    - "finish in your browser" with Cancel
    - connected as …
    - reconnect needed

    Its buttons are Set up / OAuth client, Connect, Reconnect and Disconnect (confirmed).
  - `GoogleDriveSetup`: the steps to create a client, a link to Google Cloud Console, and a masked secret that is never prefilled.
  - `ToolList`: every Test result lists tools with their title, description and badges (Read-only, Asks first, Destructive, No annotations).
  - `ToolServerForm` gets **Test**, which tests unsaved settings.
  - The agent form flags Drive when it is not connected.
  - The approval card shows Drive targets (`name`, `fileId`, `parentId`, `toFolderId`) and the full input under "Details".
  - Strings in en and pt-BR.
- **Docs:**
  - `docs/tools.md`: Google Drive, step by step how to create the OAuth client, tokens, badges, tests.
  - ADR 0010.
  - SPEC §4.3 and §7, `design.md`, `architecture.md` and CLAUDE.md are synced.

### Verification

| Check | Result |
|---|---|
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | Green. 547 tests: contract 51, runner 228, desktop 228, mcp-servers 40 (Phase 5: 494). |
| `pnpm contract:schema` / `pnpm --filter desktop db:generate` | `AppError.json`, `Message.json` and the runner protocol schemas regenerated. `0005_google_drive_tool_server.sql` is a custom migration (seed only). |
| mcp-servers | Drive, 18 tests. Over the in-memory transport against the fake: tools and annotations, and no write tools without the flag; the bearer on every call; search by text (with the exact `q`), type, folder, pages and escaping; Doc → Markdown and Sheet → CSV exports; text files, the 1 MB cap with Range, images; folders, PDFs and unknown ids refused by code; create doc/sheet/text/folder; update content and rename; move; 401 / 403 / 429 / 500 / unreachable → codes, with no token in the message. The bundled binary over stdio: token from env, `HOME` left empty, exits 2 without a token. |
| Runner | The Drive built-in gets only `--gated-by-client` (no roots), a refreshed token gives a new instance, the `gdrive__` prefix, `toToolDef` hints. |
| Desktop main | `GoogleOAuth` (10), against the fake authorization server with a stub browser: tokens with PKCE the fake verifies, auth URL parameters, the secret never in the browser URL; a wrong-state request ignored (400) and a stray path 404; denied → `oauth_cancelled`; a missing scope and a wrong secret → `oauth_failed` (not echoed); a timeout, and a cancel through the signal, with the listener closed; refresh; `invalid_grant` → reconnect; revoke; unreachable → `provider_unavailable`. `GoogleDriveService` (10): the status never carries a secret; the client kept on re-save; "connecting" while the browser is open; cancel and one attempt at a time; deny; the token reused, then refreshed once for concurrent callers; reconnect remembered with no further calls, then reconnect; disconnect revokes, forgets and stops the server; a new client ID disconnects; no keyring. `ToolServerService` (4 new): the Drive launch with a fresh token per launch, and none in the list; `google_not_connected` from runs and tests, disabled → skipped; an unsaved spec under `test-…`, stopped; edited settings with `keepSecret`, stopped on failure, built-ins refused. `ConversationService`: Drive in `run.start` with the token, and both Google codes refuse the send before anything is written. The repository seeds both built-ins. |
| Renderer logic | `store/googleDrive` (4), `store/toolServers` (probe, clearTest, `{ id }`), `toolBadges`, `approvalTargets` for Drive, i18n parity and error codes. |
| `pnpm --filter desktop test:e2e` | 36/36 green (33 earlier + 3 new in `google-drive.spec.ts`): the exit criterion, with the client set up in the UI (required ID shown), Connect → "Connected as test@example.com", Test lists 5 tools with badges, the agent ticks Drive in its form, search and read run, `create` waits, then Allow creates the Doc, every Drive call carries the OAuth token, and neither the tokens nor the client secret are in `comitiva.db*` or IPC; disconnect (revoked at the fake), then a send refused with `google_not_connected`, reconnect, and it works; a third-party server tested from the form before saving, with badges, and nothing saved. `tools.spec.ts` and `connections.spec.ts` now expect two built-ins. |
| UI | Screenshots of the setup form, the connected row with the tool list, and the approval card (`apps/desktop/test-results/drive-*.png`), in pt-BR. |
| **Real Google account** | **Not done.** It needs a Google Cloud OAuth client from the user. Next step: follow `docs/tools.md` → Google Drive, connect, read a real Doc, create one with approval, and record the result here. This also confirms that Drive exports and imports Docs as Markdown (`text/markdown`). The fallback is `text/plain` for reading and HTML for creating. |
| `pnpm dev` by hand | **Not done.** The UI path was verified through the built app in Playwright. |

### Deviations from the plan and design (all reflected in the docs)

1. The IPC is `googleDrive.*` (five channels) instead of design.md's `toolServers.connectGoogle`.
2. `toolServers.test` takes `{ id } | { spec, id? }`, so the form can test before saving.
3. The server's files are `server.ts` + `DriveApi.ts` + `bin.ts`, not `drive-api.ts` + `tools/*.ts`.
4. The fake Google lives in `@comitiva/mcp-servers/testing`, so the server tests, the desktop tests and the e2e share it. It is a real HTTP server (msw cannot reach a spawned process), as for the runner's fake providers.
5. Idle built-in instances close after 10 min. This applied only to the filesystem server before; the constant is renamed `BUILTIN_IDLE_MS`.
6. `ToolDef` also carries `title`, `idempotentHint` and `openWorldHint`, for the tool list.

### Decisions

- **Token lifecycle:** refresh when fewer than 15 min are left, before each launch. The token goes into the launch env, and a new token makes a new runner instance (ADR 0010). Refresh tokens and the client secret never leave main.
- **Scope:** full `drive`, since users run their own client in Testing or Internal status.
- **Badges:** "Destructive" follows the MCP default (`destructiveHint` true unless it says false) for tools that are not read-only. A tool without annotations shows "No annotations" instead.
- **A cancelled connect** is not shown as an error.

### Open

- **Real Google account check** (above).
- A single run longer than about 15 min can see its Drive token expire (`auth_failed`); the next run is fine.
- Sheets beyond the first tab (Drive's CSV export only covers the first one).
- The browser tab's "you can close this tab" page is English only (it is served by main, outside the renderer's i18n).
- One Google account per app. Several accounts, and OAuth for third-party http servers, are for later.
- Carried over:
  - allow-always decisions cannot be revoked from the UI
  - image tool results for non-Anthropic providers
  - `tools/list_changed`
  - Windows and macOS runs of the bridge and the servers
  - the real-provider check (Phase 1)
  - the real CLIs in the UI and Windows (Phase 2)
  - CI on GitHub (no remote)
  - the Linux sandbox, signing and icon (Phase 7)

## Next: Phase 6 — Usage

1. Records per run already exist (`usage_records`). Add pricing (`pricing.json`), estimated cost, and the summary and time-series queries.
2. The Usage screen: a dashboard by connection, agent and model over a range, plus export.
3. The right panel shows usage per conversation.
4. Done when the dashboard matches the records.

## Phase 5 — Tools: ToolServer, MCP client, tool loop, filesystem server with roots and approvals (done)

Done when an agent reads and creates a file in an allowed directory, a write asks for approval, and a path outside the root is denied: yes. The first test of `e2e/tools.spec.ts` covers it through the built app. The agent is set up in the form (folder picker, Files, "Ask before changes"). It reads a file on its own. The write waits on the approval card, the sidebar says "Approve", and after **Allow** the file is on disk. A read outside the folder comes back `outside_roots` from the server. The same path is covered for both CLI harnesses through the runner's MCP proxy, and by hand with the real Claude Code and Codex.

#### Done

- **Approval handshake (confirmed before implementing), ADR 0009:**
  - The runner is the only MCP client of every server.
  - API runs: the tool loop calls `Run.callTool`.
  - CLI harnesses: they get a single MCP server, `comitiva`, which is `mcp-proxy.cjs` launched by the harness. It forwards every call over a local socket, with a per-run token, to the same `Run.callTool`.
  - `PermissionGate` decides allow, ask or deny. `ask` emits `run.tool_call { requiresApproval }` and waits for `run.approval`.
  - The filesystem server never asks. It exposes write tools only when started with `--gated-by-client`.
- **Contract:**
  - `ToolServerLaunch` (a server with its secrets resolved) in `toolServer.start` (plus `roots`) and in `run.start.toolServers`.
  - IPC `toolServers.list | create | update | delete | test` and `approvals.decide`.
  - `ToolServerDraft`/`Patch`, whose values are `{ value } | { secret } | { keepSecret }`.
  - `PendingApproval` on `ConversationSummary` and on `conversation.updated`.
  - New error codes `read_only_root`, `tool_failed` and `tool_server_failed`.
  - `AgentParams.maxToolIterations`, `ToolUseBlock.signature`, and `FILESYSTEM_TOOL_SERVER_ID`.
- **mcp-servers:** `filesystem` (`dist/filesystem.cjs`, bin `comitiva-mcp-filesystem`).
  - Tools: `list_dir`, `read_file` (text by line range, or images), `search` (name glob plus content), `write_file`, `create_dir`, `move` and `delete`, annotated `readOnlyHint` or `destructiveHint`.
  - `RootGuard` compares the realpaths of the candidate and the roots. It refuses `..`, absolute paths outside the roots, symlinks pointing out, dangling symlinks, and writes under read-only roots. The most specific root wins.
  - Errors come back as `isError` results that start with the stable code.
- **Runner:**
  - `McpClientManager` keeps one client per server launch (stdio, or Streamable HTTP).
    - Clients start on demand, are reused across runs, and restart on their next use after a crash. Failed starts back off.
    - The filesystem server runs one instance per set of roots.
    - An edited server replaces its client once the client is idle.
  - `ToolCatalog` gives prefixed names (`fs__read_file`).
  - `PermissionGate`: allow-always, the three policies, and read-only tools hidden under `read-only`.
  - `toolLoop` runs for all four API adapters:
    - Anthropic `tool_use` with streamed JSON
    - OpenAI `tool_calls`
    - Gemini `functionCall`, with thought signatures sent back
    - Ollama `tool_calls`

    It has an iteration limit (25) and one summed usage per run.
  - `normalizeHistory` turns stored replies into strict tool_use/tool_result pairs.
  - `toolServer.start/stop` and `run.approval`, plus `RunnerClient.startToolServer/stopToolServer`.
  - CLI harnesses:
    - `ToolBridge` and `mcp-proxy.cjs`.
    - Claude Code gets `--mcp-config`, `MCP_TOOL_TIMEOUT`, and `--tools WebSearch,WebFetch` when the agent has Files.
    - Codex gets `-c mcp_servers.comitiva.*` with `default_tools_approval_mode="approve"`, and a read-only sandbox when the agent has Files.
    - The parsers drop the harness's own copy of proxy calls.
    - The working directory is the agent's first read-write root.
  - Test kit:
    - the in-memory fake MCP server (`createFakeMcp`)
    - `[tool:NAME {json}]` in the fake providers
    - `[mcp:NAME {json}]` in the fake harnesses, which really connect to the proxy
- **Desktop main:**
  - Migration `0004_builtin_tool_servers` seeds the Files server.
  - `ToolServerRepository` and `ToolApprovalRepository`.
  - `ToolServerService`:
    - Secret env vars and headers go to the SecretStore (`toolServer:<id>:env|header:<NAME>`).
    - It resolves launches per run, restarts servers in the runner after edits, and tests them through `toolServer.start`.
    - Built-ins can only be toggled.
  - `ConversationService`:
    - `run.start` carries the servers and `alwaysAllowed`.
    - A call that needs approval sets `awaiting-approval` and a pending approval.
    - `decide` records the decision and answers the runner.
    - `tool_use` and `tool_result` blocks are kept in the reply.
  - Agent roots must be absolute.
  - Packaging ships `mcp-proxy.cjs` next to the runner, and `mcp-servers/filesystem.cjs`.
- **Renderer:**
  - `Backend.toolServers` and `Backend.approvals`.
  - A pending approval per conversation. The agent status order is awaiting-approval > running > error > idle.
  - `ToolCallBlock` states: waiting for you, running, done, failed, denied, no result.
  - `ApprovalCard`: Allow / Deny / Always allow for this agent, with the paths involved.
  - Sidebar "Approve" flag.
  - Tools screen: a built-in badge, an enable switch, Test (lists the tools, read-only marked), and a form for stdio or http servers whose secret rows are masked and never prefilled.
  - Agent form: Folders (native picker, read or read-write, reorder), the Tools checklist and the permission policy. The panel shows them.
  - Strings in en and pt-BR, including the Codex warning, which now explains the read-only sandbox.
- **Docs:** `docs/tools.md` (new) and ADR 0009. SPEC §4.1–4.3 and §7, `design.md`, `architecture.md` and `providers.md` are synced.

#### Verification

| Check | Result |
|---|---|
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | Green. 494 tests: contract 49, runner 226, desktop 197, mcp-servers 22 (Phase 4: 395). |
| `pnpm contract:schema` / `pnpm --filter desktop db:generate` | `Agent.json`, `AppError.json`, `Block.json`, `Message.json` and the runner protocol schemas regenerated. `0004_builtin_tool_servers.sql` is a custom migration (seed only). |
| mcp-servers | `RootGuard` (10 tests): relative paths; `..`; absolute outside; a symlinked file and folder pointing out, and new files under them; a dangling symlink; symlinks that stay inside; a symlinked root; read-only roots and nested roots; no roots; NUL. Every tool over the in-memory transport, including 15 escape attempts that leave the outside untouched, no write tools without `--gated-by-client`, and the bundled binary over stdio. |
| Runner | The loop with a scripted adapter and the fake MCP server (13): read-only runs, allow, deny, allow-always within a run and from `run.start`, allow-writes, read-only hides and refuses, cancel while waiting, cancel during a slow tool (the server sees the cancel), the iteration limit, a crash mid-call then a restart, a server that cannot start plus backoff, reuse across runs, name collisions. Units: gate, history, results, catalog, manager (roots, supersede, stop), bridge token. The conformance suite adds a tool round trip for all four providers. The runner binary with the real filesystem server (Anthropic and OpenAI-compatible): read, write after approval, refused outside, deny, cancel. Both fake harnesses through the proxy: argv (`--tools`, `--mcp-config`, read-only sandbox, `default_tools_approval_mode`), cwd = root, the config removed after the turn. |
| Desktop main | Repositories: seed, secret refs only, built-ins protected, approvals and `alwaysAllowed`. `ToolServerService` (8): secrets never in SQLite, launches, missing secret, keep/replace/drop secrets, built-ins, keyring unavailable, test. `ConversationService` (7 new): servers and `alwaysAllowed` in `run.start`, awaiting approval with the pending approval in events and lists, decide once, blocks persisted and replayed, allow-always reaching the next run, cancel while waiting, `secret_missing` before writing. |
| Renderer logic | `store/conversations` (pending, decide, status order), `store/toolServers`, `lib/toolServerForm`, `lib/agentForm` (folders, tools, policy), `lib/chat` (labels, states, targets), i18n parity and error codes. |
| `pnpm --filter desktop test:e2e` | 33/33 green (28 earlier + 5 new in `tools.spec.ts`): the exit criterion; deny; allow always for one agent (another still asks, and Stop while waiting leaves no file); a CLI harness through the proxy under Electron; the Tools screen (built-in test lists 7 tools, a third-party server with a secret env var that is in neither `comitiva.db*` nor the listing, edit keeps it, disable removes it from the agent form). |
| **Real CLIs**, by hand through the runner binary with the real filesystem server | **Claude Code 2.1.278**: it read `notes.txt` through the proxy, `write_file` waited for approval, and `answer.txt` was created. Block ids are Claude's own `toolu_…` (from `_meta`). **Codex 0.155.1**: the same, after adding `default_tools_approval_mode="approve"`. Without it, Codex declined `write_file` itself ("unavailable without approval") and never called the proxy. |
| UI | Screenshots of the approval card, the finished tool blocks (with the `outside_roots` result expanded) and the Tools screen (`apps/desktop/test-results/tools-*.png`), in pt-BR. |
| `pnpm dev` by hand | **Not done.** The UI path was verified through the built app in Playwright. |

#### Deviations from the plan and design (all reflected in the docs)

1. **Handshake:** the runner's MCP proxy instead of the filesystem server asking over `--approval-socket` (ADR 0009, confirmed before implementing). Third-party servers are gated under harnesses too, and no secret goes into a temp file.
2. `toolServer.start` takes a resolved `ToolServerLaunch` (secrets inside) instead of `toolServer` plus `secrets`. `run.start` gained `toolServers`.
3. There is no `approval.requested` event. The pending approval rides on `conversation.updated` and `conversations.list`.
4. A reply keeps its `tool_use` and `tool_result` blocks in one assistant message. The runner splits it into assistant/tool turns (`normalizeHistory`), instead of main writing separate `tool` messages.
5. There is no `ApprovalService`: `decide` lives in `ConversationService`, which owns the live run.
6. The built-in server has the fixed id `filesystem`, seeded by a custom SQL migration. There is no new column, and its command is resolved by main at run time.
7. Filesystem tool names follow design.md (`list_dir`, `read_file`, …). SPEC is updated.
8. Under the `read-only` policy, write tools are hidden from the model as well as refused.
9. `ToolUseBlock.signature` was added for Gemini thought signatures.
10. MCP client instances are keyed by server plus launch spec and roots. Idle filesystem instances close after 10 min.

#### Decisions

- **New folders** are read-write (writes still ask under the default policy). The first folder turns on the Files tool.
- **Allow always** applies to one server's tool for one agent, from that moment in the run and in every later run.
- **Claude Code with Files:** only `WebSearch` and `WebFetch` stay native. Bash is off too, because it can write files.
- **Codex with Files:** a read-only sandbox (`apply_patch` cannot be turned off), and `default_tools_approval_mode="approve"` for the proxy (the runner is the gate).
- **A server that cannot start** fails the run with `tool_server_failed`, instead of running without it.

#### Open

- Allow-always decisions cannot be revoked from the UI yet. They are rows in `tool_approvals`.
- Tool results with images reach Anthropic as images, but OpenAI-compatible, Gemini and Ollama get `[image not shown]` (their tool results are text here).
- MCP `tools/list_changed` is not followed: tools are listed once per client start. HTTP servers use Streamable HTTP only: no SSE fallback, and OAuth comes in 5b.
- `RootGuard` does not defend against a process swapping a folder for a symlink between the check and the operation. `delete` or `move` on a symlink inside the roots acts on its target, which is also inside.
- The bridge (named pipe), the proxy and the filesystem server have not run on Windows or macOS.
- The real-provider check with tools: no API key on the dev machine (carried over from Phase 1).
- Carried over: the real CLIs in the UI and Windows (Phase 2), CI on GitHub (no remote), the Google Drive server choice (5b), and the Linux sandbox, signing and icon (Phase 7).

## Phase 4 — Full chat with parallelism, persistence, retry, auto-title (done)

Done when two agents respond at the same time: yes. Two agents stream at once and the sidebar shows both responding (e2e `chat.spec.ts`, first test).

#### Done

- **Contract**:
  - New channels:
    - `conversations.list | create | rename | archive | markRead`: `list` takes `{ agentId?, archived }` and returns `ConversationSummary { conversation, unread }`
    - `messages.list | send | cancel | retry`: `list` returns `MessagePage { messages, hasMore, rev }`
  - `UserContent`: text, image and document blocks, not empty. Tool blocks come only from runs.
  - Events: `conversation.updated`, `message.updated` (snapshot), `message.delta` and `message.block`, all numbered by one `rev` per conversation (ADR 0008).
  - `Message.error` (an `AppErrorShape` or null), and the error codes `conversation_busy` and `interrupted`.
  - `appendText(content, text)` is the one rule for applying deltas, shared by main and the renderer.
  - `titleModelFor(provider, preset, model)` picks the cheap title model for each API provider and preset.
- **Desktop main**:
  - Migration `0003_chat` adds `messages.error`, `conversations.harness_connection_id` and `conversations.last_read_seq`.
  - `ConversationRepository`, `MessageRepository` (pages by `seq`), and `UsageRepository` (insert and list, for now).
  - `ConnectionService.secretFor` reads the key for a run.
  - `ConversationService`:
    - Each conversation runs on its own, with no global queue, and at most one reply at a time (`conversation_busy`). A send is refused before anything is written when the connection is disabled, the model is missing or the key is missing.
    - Text is coalesced to the UI every 16 ms and checkpointed to SQLite about every 250 ms. On the terminal event, the final message, one usage record per run and the status go in one transaction.
    - Cancel keeps the partial reply and finalizes locally if the runner never answers. Retry resets the failed reply in place. A runner crash gives a retryable error.
    - A harness session is saved as soon as it arrives and resumed only on the same connection. CLI turns get `resolveWorkingDirectory`.
    - At boot, replies left streaming become `error { interrupted }`. On quit, running replies are finalized as cancelled.
    - `forgetAgent` stops an agent's runs before it is deleted.
  - `TitleService`: the first line of the first message is the placeholder title. After the first complete reply, a separate cheap-model run replaces it, unless the user renamed the conversation meanwhile. API connections only; the title run's usage is recorded without a message.
- **Renderer**:
  - `Backend.conversations` / `Backend.messages` and their events.
  - `conversations` store: lists per agent (newest activity first), archived on demand, selection per agent, what is on screen, unread, and `forgetAgent`. Its selectors give the agent status (running > error > idle) and unread count.
  - `messages` store: pages, older pages, drafts per conversation, send / cancel / retry. Events are applied by `rev`; events that arrive during a load are buffered, and a gap reloads the page.
  - Agents screen center: `ConversationList` and `ChatView`.
    - The list has New conversation, rename in place (✎ or double-click), archive and unarchive, Show archived, and a status dot and unread count per row.
    - The chat has a header, a virtualized `MessageList` (react-virtuoso) and the `Composer`.
    - Opening an agent opens its most recent conversation. "New conversation" shows an empty composer, and the first send creates the conversation.
  - `MessageBubble`:
    - User text is shown plain; replies are Markdown (react-markdown + remark-gfm, no raw HTML) with code blocks you can copy.
    - It shows a streaming cursor at the end of the text, "Stopped", and a failed reply's error by code, with Retry on the last message.
    - `ToolCallBlock` shows harness tool calls as collapsible blocks.
  - `Composer`: Enter sends, Shift+Enter adds a line, Stop while running. It is blocked with the reason when the connection is disabled or missing.
  - Sidebar: the agent status dot (idle, responding, error) and an unread badge. Opening the conversation marks it read.
  - Deleting an agent says how many conversations go with it, archived ones included (closes a Phase 3 open item).
  - Strings in en and pt-BR. A new test checks that every `ErrorCode` has a translation; `conversation_busy` and `interrupted` were missing.
- **Docs**: ADR 0008 (live message events and revisions). `design.md` and `architecture.md` are synced.

#### Verification

| Check | Result |
|---|---|
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | Green. 395 tests: contract 43, runner 188, desktop 163, mcp-servers 1 (Phase 3: 329). |
| `pnpm contract:schema` / `pnpm --filter desktop db:generate` | `Message.json`, `AppError.json` and the runner protocol schemas regenerated and committed. `0003_chat.sql` holds only the three new columns. |
| Main (in-memory SQLite + migrations, fake runner) | `ConversationRepository` (9 tests). `ConversationService` (25 tests): history and the persisted reply; 16 ms and 250 ms batching; text around blocks; one usage row; two conversations streaming at once; double send; nothing persisted on refusal; cancel with and without a runner answer; error then retry in place; crash; late events; harness session per connection; history filtering; a page mid-stream lining up with later deltas; rev order per conversation; shutdown; crash recovery; forgetAgent; titles (placeholder, generated, rename wins, CLI and failures get none). Also `ConnectionService.secretFor`. |
| Renderer logic | `store/conversations` (8), `store/messages` (8: rev, gaps, buffering, stale snapshots, drafts), `lib/chat` (9), and the i18n error-code check. |
| `pnpm --filter desktop test:e2e` | 28/28 green (20 earlier + 8 new `chat.spec.ts`). Covered: two agents stream at once, both "responding" in the sidebar, and the one off screen ends with an unread badge; opening it clears the badge, and the placeholder title gives way to the generated one; the second turn sends the history; Stop keeps the partial reply; `auth_failed` shows by code, then Retry after fixing the key streams into the same message; rename and archive; everything survives a restart; deleting an agent. |
| UI | Screenshots of the parallel stream, the error card and the restored conversation (`apps/desktop/test-results/`), in pt-BR (the machine locale). |
| `pnpm dev` by hand | **Not done.** The UI path was verified through the built app in Playwright. |

#### Deviations from the plan and design (all reflected in docs/design.md)

1. The channel set changed from the Phase 0 sketch. `conversations.listByAgent` became `conversations.list({ agentId?, archived })`, so one call at boot loads every agent's status and unread count. `setStatus` is not a channel, because status belongs to main. `markRead` is new.
2. `message.completed` became `message.updated`, a full snapshot sent on create, on reset for retry and at the end. Each message event carries a per-conversation `rev`; it started per reply and was changed in `495ca1e`. See ADR 0008.
3. `ConversationService` does not take the approvals repository yet (Phase 5), and it gets the key through `secretFor` instead of the `SecretStore`.
4. There is no `ChatScreen`: the chat lives in the Agents screen's center column, as SPEC §5 describes.
5. The harness session is stored with the connection it belongs to (`harness_connection_id`). Moving an agent to another connection therefore replays the history instead of resuming a foreign session.

#### Decisions

- **Selection**: opening an agent shows its most recent conversation. "New conversation" is an explicit empty state, and the conversation is created on the first send.
- **Unread**: a finished reply counts as unread unless its conversation is on screen. The count is persisted as `last_read_seq`, so it survives a restart.
- **Titles**: a placeholder (the first line) right away, then one cheap-model call after the first reply. A rename by the user always wins.
- **Markdown**: GFM with no raw HTML and no syntax highlighting (fewer dependencies; highlighting can come in Phase 7).

#### Open

- If the first send from "New conversation" is refused (for example `model_required`), the conversation that was just created stays, empty, with the draft kept in it.
- Replies are marked read while their conversation is on screen, even when the app window is in the background.
- Virtuoso keeps rows hidden for one frame while it measures a conversation that was just opened.
- Right-panel conversation usage waits for Phase 6. The Cmd/Ctrl+K quick switcher and attachments wait for Phase 7.
- Carried over: the real-provider check (Phase 1), the real CLIs in the UI and Windows (Phase 2), CI on GitHub (no remote), the Google Drive server choice (5b), and the Linux sandbox, signing and icon (Phase 7).

## Phase 3 — Agents: CRUD, role, model, avatar (done)

Done when an agent shows up in the sidebar: yes, created from the sample offer or the form (e2e).

#### Done

- **Contract**:
  - `AgentAvatar = { color, emoji? }`: `color` is one of 10 palette names (`AvatarColor`); without an emoji the UI shows the name's initials. `Agent.avatar` uses it.
  - Tags are trimmed, at most 32 characters each and at most 20 per agent.
  - `AgentDraft` applies defaults (role, params, tags, roots, tool servers, policy `ask`) and turns a blank model into `null`, meaning the connection's default. `AgentPatch` is the same shape with every field optional. `ValidAgentDraft` / `ValidAgentPatch` are the parsed types.
  - `AppSettings` (`sampleAgentOffer: pending | done`) and `AppSettingsPatch`.
  - New channels:
    - `agents.list | create | update | delete | duplicate` (duplicate takes an optional localized name)
    - `settings.get | update`
  - New error codes `connection_disabled` and `model_required`.
  - `IpcInput<C>` is now what callers send (`z.input`), and `IpcParsedInput<C>` is what handlers receive.
- **Desktop main**:
  - Migration `0002_agent_settings` adds `app_settings` (key → JSON) and `agent_roots.position`.
  - `agents.avatar` is read as JSON. Only the TS type changed; the DDL did not.
  - `AgentRepository`:
    - Roots (ordered) and tool server ids are loaded and saved with the agent, in one transaction.
    - Writes are validated by the `Agent` schema. A repeated root or an unknown tool server → `invalid_request`.
    - Connection rule: on create, duplicate, and updates that change the connection or model, the connection must exist (`not_found`) and be enabled (`connection_disabled`). An API connection needs the agent's model or its own default (`model_required`), matching the runner's rule in `Run.ts`.
    - An agent whose connection was disabled later can still be renamed and have its role edited.
  - `ConnectionRepository.agentsUsing(id)`, so `connection_in_use` now names the agents.
  - `SettingsRepository` falls back to defaults for missing or invalid values.
  - `AgentService` is thin; `duplicate` falls back to "<name> (copy)". IPC handlers are wired in `index.ts`.
- **Renderer**:
  - `Backend.agents` / `Backend.settings`.
  - The `agents` store:
    - list, selection, and the editor (create with prefill, or edit)
    - inline role update, duplicate, and delete with confirmation
    - models per connection, fetched once per session, with a retry on failure
    - `createSample` / `dismissSample`
  - Sidebar `AgentList`:
    - one row per agent: avatar, name, a grey status placeholder (`data-status="idle"`), and a ⚠ when the connection is disabled or missing
    - "+" for a new agent
    - empty state: "Create agent", or "Add a connection first"
  - `AgentsScreen`:
    - center: the selected agent, with a placeholder where conversations go in Phase 4. With nothing selected: the sample offer, "add a connection first", or "pick / create".
    - right panel `AgentPanel`: connection, model (or "connection default (X)" / "the harness's default"), temperature, max tokens, tags, Edit / Duplicate / Delete, and the role **edited in place** (click or Edit; Ctrl/Cmd+Enter or Save; Esc cancels).
  - `AgentForm`:
    - name, and an avatar picker (10 swatches, 24 emojis, a typed emoji, or initials)
    - connection: `<optgroup>` API / CLI, enabled only, plus the current one marked "(disabled)"
    - model: a datalist fetched through `connections.listModels` when the provider lists models; free text for CLI (blank = the harness's default); required when an API connection has no default
    - role, with the templates Generic Assistant, Researcher, Writer, Reviewer and File Organizer. Their text is in i18n, so pt-BR gets Portuguese prompts. Replacing text the user typed asks first.
    - temperature (0–2) and max tokens (positive integer), hidden for CLI with a note; other params such as topP are kept on edit
    - tags as chips (Enter or comma; Backspace removes the last)
  - **Sample agent**: on first run, when there is at least one enabled connection and no agents, a card offers "Assistant" (🤖, the Generic Assistant role, the first enabled connection).
    - One click creates it. If that connection has no default model, the prefilled form opens instead.
    - "Not now" dismisses it. Either way `sampleAgentOffer` becomes `done` in SQLite, so the offer never comes back.
  - **Deleting a connection in use**: the confirmation lists the agents that use it and disables Delete. Main refuses too (`connection_in_use`, with the names).
  - The app opens on Agents once a connection exists (Connections on a fresh install), unless the user already navigated.
  - `FormShell` takes `icon` and `title`; `Async` moved to `lib/async.ts`; `ConfirmDialog` takes `blocked`.
  - Strings are in en and pt-BR, and a new test keeps both files' keys in sync.

#### Verification

| Check | Result |
|---|---|
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | Green. 329 tests: contract 38, runner 188, desktop 102, mcp-servers 1 (Phase 2: 285). |
| `pnpm contract:schema` / `pnpm --filter desktop db:generate` | `Agent.json`, `AppError.json` and the runner protocol schemas regenerated and committed. `0002_agent_settings.sql` holds only `app_settings` and `agent_roots.position`. |
| Repository and validation (in-memory SQLite + migrations) | `AgentRepository` (12 tests): round trip of every field; roots and tool servers saved, reloaded in order, replaced, kept on other updates and cascaded on delete; an unknown tool server or a repeated root writes nothing; `not_found` / `connection_disabled` / `model_required` (API without a default vs. a connection default vs. CLI); re-checked when the connection or model change; rename on a since-disabled connection; duplicate copies everything; `connection_in_use` names the agents. Also `SettingsRepository` (defaults, persisted, invalid value → default) and `AgentService` (duplicate name). |
| Renderer logic | `lib/agentForm` (8 tests: form ⇄ draft/patch with topP kept, problems, connection groups, model list and params support, tags, initials), `store/agents` (12), `store/app` (landing), i18n key parity. |
| `pnpm --filter desktop test:e2e` | 20/20 green (13 earlier + 7 new `agents.spec.ts`): with no connection Agents points to Connections; the first Ollama connection brings the sample offer, and one click puts "Assistant" in the sidebar; an agent on an Anthropic connection with no default model (models fetched from the fake server, model required, Writer template then a confirmed replace, emerald + ✍️, temperature, max tokens, tags); the role edited in place survives a reload, and Esc discards; duplicate then delete; deleting a used connection lists the agent with Delete disabled; a disabled connection shows the warning, the role can still be edited, and the agent moves to another connection. `connections.spec.ts` now expects the Agents landing after a reload. |
| UI | Screenshots of the sample offer, form and panel (`apps/desktop/test-results/`), checked in light, in dark (`emulateMedia`) and in pt-BR. |
| `pnpm dev` by hand | **Not done.** The UI path was verified through the built app in Playwright. |

#### Deviations from the plan and design (all reflected in docs/design.md)

1. Migration 0002 also adds `agent_roots.position`: SQLite returned roots in path order, and SPEC §4.2 makes the *first* readwrite root a harness's working directory, so the order the user gives must be kept.
2. The list of agents using a connection is `ConnectionRepository.agentsUsing`, not `AgentRepository.namesUsingConnection`: the delete that needs it lives there.
3. Validation lives in `AgentRepository` (inside the write transaction); `AgentService` stays thin until conversations arrive.
4. `IpcInput` became the pre-default input type, so the renderer can omit defaulted fields. Handlers use the new `IpcParsedInput`.
5. Duplicating an agent whose connection is disabled fails with `connection_disabled` (a duplicate is a create).
6. The sample offer shipped in the same commit as the rest of the renderer.

#### Decisions

- **Avatar**: always a palette color plus an optional emoji; initials otherwise. Palette names, not hex, so each shell picks light and dark shades.
- **Sample agent**: one click, with a persisted flag (`app_settings.sampleAgentOffer`). It falls back to the prefilled form when the connection needs a model.
- **Deleting a connection in use**: checked up front in the dialog, which lists the agents; main refuses as well. `AppErrorShape` did not grow a details field.

#### Open

- The model list is cached per connection for the session. After a connection's key or URL changes, the agent form shows the old list until the app restarts (Retry only shows on a failure).
- Agents are ordered by creation; there is no manual reordering, and tags are not used for filtering yet.
- Deleting an agent will cascade its conversations from Phase 4: the confirmation should then say how many.
- Roots, tool servers and the permission policy are stored but have no UI (Phase 5).
- Carried over: the real-provider check (Phase 1), the real CLIs in the UI and Windows (Phase 2), CI on GitHub (no remote), the Google Drive server choice (5b), and the Linux sandbox, signing and icon (Phase 7).

## Phase 2 — CLI harnesses (Claude Code, Codex), session resume (done)

#### Done

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

#### History per harness

| Harness | Kept by | How |
|---|---|---|
| Claude Code | the harness | `--resume <session_id>` (from `system/init`); only the new message is sent |
| Codex | the harness | `codex exec resume <thread_id> -` (from `thread.started`); only the new message is sent |
| Either, without a session (first turn, moved conversation, lost session) | Comitiva | the earlier messages are replayed as a transcript prompt, and a new session starts |

#### Verification

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

#### Deviations from the plan and design (all reflected in docs/design.md)

1. CLI descriptors live in a separate `cliProviderDescriptors` map, so the API `providerDescriptors` keeps its exact typed shape.
2. `streamTurn`, `UsageTracker` and `httpError` stay in `providers/api/shared.ts`, and the CLI adapters import them from there. The plan had moved them to `providers/shared/`.
3. The fake harness generates lines in the recorded formats instead of replaying the fixture files, so `dist/testing` has no dependency on `test/`. The parsers are tested against the real recordings.
4. `fakeHarnessBinaries(runnerPackageDir)` takes the package directory, because Playwright loads `@comitiva/runner/testing` as CommonJS (no `import.meta`).
5. The Claude Code login command is `claude auth login` (what 2.1.278 has), not `claude login`.
6. Working directories are resolved in main, but no run uses them from the app yet: chat arrives in Phase 4. The runner path is covered by tests.
7. CLI connections need no model: without one, the harness uses its default (`--model` / `-m` are omitted).
8. A relative working directory or binary path is refused in the form; `~` is not expanded for working directories.

#### Decisions

- **Codex streaming**: `exec --json`, one message at a time. The experimental `app-server` gets revisited when it is stable.
- **Native tools until Phase 5**: kept, with auto-accept, and explained in the form.
- **Codex sandbox**: per connection, `workspace-write` by default. testConnection detects a sandbox that cannot start.
- **Isolation**: harnesses do not load the user's CLI settings or MCP servers; `extraArgs` can override that.

#### Open

- **Windows**: spawning `.cmd` shims and `taskkill /T` are implemented but not run on Windows. The fake harness is a POSIX script, so the CLI e2e is skipped there. The Codex sandbox probe on macOS is not verified either.
- **Codex native writes**: `apply_patch` cannot be turned off, so Codex writes will never go through Comitiva's approvals. Phase 5 decides whether Codex only ever gets `read-only` when the agent has a `filesystem` server.
- A harness that ignores SIGTERM is killed 3 s later; a runner crash mid-turn can orphan a harness. Revisit with the Phase 4 chat.
- Carried over: real API provider check (Phase 1), CI on GitHub (no remote), Google Drive server choice (5b), Linux sandbox/signing/icon (Phase 7).

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
