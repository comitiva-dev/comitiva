# Comitiva — Specification

> **Comitiva — agentic chat for your whole team.**
>
> This document is the source of truth for what the product is and how it is organized. Technical detail (classes, commands, data model, flows) lives in `docs/design.md`. The roadmap by phase is in section 6; the current state is in `docs/STATUS.md`.

### 1. Vision

An open source desktop application where users register **connections** to LLMs (APIs or command-line harnesses such as Claude Code and Codex), create **agents** with a role and a set of **tools** (local folders, Google Drive, any MCP server), and talk to all of them in a **Slack-style chat** interface, with many conversations running in parallel. Later, a **hub** in Laravel lets teams share agents and conversations, and a **web interface** reaches the hub without the desktop.

What it is not: a coding tool. Nothing in the core assumes Git, repositories or a terminal. Those can come in as an MCP server like any other tool.

### 2. Principles

1. **Generic by default.** Agents can research, write, review, organize files. Code is just one case.
2. **The runner is the product.** All execution logic (adapters, tool loop, MCP, streaming, cancellation, usage) lives in an independent Node process with its own protocol. Electron is a client of it. Any other shell (NativePHP, CLI, server) can be too.
3. **Local-first.** Without the hub, everything works offline with SQLite. The hub is optional and syncs.
4. **Secrets never in plain text.** API keys and OAuth tokens go through Electron's `safeStorage`, outside SQLite.
5. **The user sees and controls what the agent does with files.** Reading inside the roots is free; writing asks for approval; outside the roots is denied.
6. **Shared contract, not shared code.** Desktop (TS) and hub (PHP) share the JSON schemas for messages, blocks, events and entities, published in `packages/contract`. Each side implements them as best fits its world.

### 3. Domain concepts

```
Connection ──1:N──▶ Agent ──1:N──▶ Conversation ──1:N──▶ Message
                      │                                      │
                      ├── N:M ── ToolServer               UsageRecord
                      └── roots[] (directories + mode)
```

**Connection** — a way to reach an LLM.
`id`, `name`, `kind` (`api` | `cli`), `provider` (`anthropic`, `openai-compatible`, `google`, `ollama`, `claude-code`, `codex`, `gemini-cli`, …), `config` (JSON per provider), `secretRef`, `enabled`, `createdAt`. Action: test connection.

**ToolServer** — an MCP server.
`id`, `name`, `transport` (`stdio` | `http`), `command`, `args`, `env` (sensitive values via `secretRef`), `url`, `headers`, `builtin` (bool), `enabled`. Built-ins in v1: `filesystem` and `google-drive`. The user can register any other.

**Agent** — a persistent persona.
`id`, `name`, `avatar`, `connectionId`, `model` (optional), `role` (system prompt), `params`, `toolServerIds[]`, `roots[]` (`{ path, mode: 'read' | 'readwrite' }`), `permissionPolicy` (`ask` | `allow-writes` | `read-only`), `fallbackConnectionIds[]` (Phase 10), `tags`.

**Conversation** — `id`, `agentId`, `title`, `status` (`idle` | `running` | `awaiting-approval` | `error`), `harnessSessionId`, `archived`, `lastActivityAt`.

**Message** — `id`, `conversationId`, `role` (`user` | `assistant` | `tool`), `content: Block[]`, `status` (`streaming` | `complete` | `cancelled` | `error`), `createdAt`.
Blocks follow the Anthropic Messages API format as canonical: `text`, `image`, `document`, `tool_use`, `tool_result`. Adapters translate to the provider's format.

**ToolApproval** — approval record: `id`, `conversationId`, `toolUseId`, `toolServerId`, `toolName`, `input`, `decision` (`allow` | `deny` | `allow-always`), `decidedAt`.

**UsageRecord** — `id`, `connectionId`, `agentId`, `conversationId`, `messageId`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `estimated` (bool), `estimatedCostUsd`, `latencyMs`, `createdAt`.

### 4. Architecture

```
repo/
├── packages/
│   ├── contract/     # zod schemas + generated JSON Schema: entities, blocks, events, runner protocol
│   ├── runner/       # Node process: adapters, MCP, tool loop, engine, usage. No Electron.
│   └── mcp-servers/  # built-in MCP servers: filesystem (with roots), google-drive, documents (future)
├── apps/
│   ├── desktop/      # Electron: main (runner client, SQLite, secrets, IPC) + React renderer
│   ├── hub/          # Phase 8: Laravel + Reverb + Postgres
│   └── web/          # Phase 9: React served by the hub, reuses desktop components
├── docs/
├── SPEC.md
└── CLAUDE.md
```

**Desktop stack:** Electron + electron-vite, React 19, TypeScript strict, Tailwind, Zustand, SQLite via better-sqlite3 with Drizzle migrations (ADR 0003), zod-typed IPC, vitest, Playwright.

**Runner stack:** Node 22+, TypeScript, `@modelcontextprotocol/sdk`, official Anthropic SDK, OpenAI-compatible client, Gemini client, fetch for Ollama. No dependency on Electron or a database: the runner is stateless with respect to persistence; it receives the history and returns events. The shell persists. The desktop runs it with the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE`, ADR 0002); any Node ≥ 22 can run it standalone.

**Hub stack:** Laravel 12+, Reverb, Sanctum, Postgres, Pest. Implements the `contract` in PHP (validation via generated JSON Schema).

#### 4.1 Runner protocol

Child process of the shell, JSON lines on stdin/stdout, one line per message. The shell may restart it; the runner keeps no state across restarts other than open MCP sessions.

Requests (shell → runner):

```ts
type RunnerRequest =
  | { id; type: 'ping' }                                         // → { version, protocolVersion }
  | { id; type: 'connection.test'; connection; secret? }
  | { id; type: 'connection.listModels'; connection; secret? }
  | { id; type: 'toolServer.start'; toolServer; secrets? }     // opens MCP client, returns tool list
  | { id; type: 'toolServer.stop'; toolServerId }
  | { id; type: 'run.start'; runId; conversationId; agent; connection; secret?; messages: Message[]; harnessSessionId?; alwaysAllowed? }
  | { id; type: 'run.cancel'; runId }
  | { id; type: 'run.approval'; runId; toolUseId; decision: 'allow' | 'deny' | 'allow-always' }
  | { id; type: 'shutdown' }
```

Events (runner → shell), always with `runId` when they belong to a run. Run events also carry `ts` (emission time, epoch ms) for latency measurement:

```ts
type RunnerEvent =
  | { type: 'response'; id; ok: true; result } | { type: 'response'; id; ok: false; error }
  | { type: 'run.session'; runId; harnessSessionId }
  | { type: 'run.text_delta'; runId; text }
  | { type: 'run.block'; runId; block: Block }                   // complete block (image, tool_use...)
  | { type: 'run.tool_call'; runId; toolUseId; toolServerId; toolName; input; requiresApproval: boolean }
  | { type: 'run.tool_result'; runId; toolUseId; output; isError; durationMs }
  | { type: 'run.usage'; runId; inputTokens; outputTokens; cacheReadTokens?; cacheWriteTokens?; estimated }
  | { type: 'run.done'; runId; stopReason }                      // stopReason 'cancelled' after run.cancel
  | { type: 'run.error'; runId; code; message; retryable }       // code = stable AppError code
  | { type: 'log'; level; message }
```

Every run ends with exactly one terminal event (`run.done` or `run.error`). Cancelling is not an error: it ends with the usage known so far (estimated if the provider had not reported it) and `run.done { stopReason: 'cancelled' }`. If the runner process dies, the shell reports `run.error { code: 'runner_crashed', retryable: true }` for its active runs. The full protocol reference is in `docs/architecture.md`.

#### 4.2 Connection adapters

```ts
interface ProviderAdapter {
  id: string; kind: 'api' | 'cli';
  capabilities: { streaming; tools; resume; listModels; usage; images };
  testConnection(config, secret?): Promise<TestResult>;
  listModels?(config, secret?): Promise<ModelInfo[]>;
  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent>;
}
```

`RunContext` gives the adapter `tools` (definitions aggregated from the agent's MCP servers) and `callTool(toolUseId, name, input)`, which already goes through the permission policy and returns the result or a denial.

- **API** (`anthropic`, `openai-compatible`, `google`, `ollama`): the runner controls the loop. Streaming → `tool_use` → `ctx.callTool` → `tool_result` → new call, until a `stopReason` without tools, with a configurable iteration limit.
- **CLI** (`claude-code`, `codex`; `gemini-cli` later): the runner starts the binary once per turn in non-interactive mode with streaming JSON output, the prompt on stdin, and translates lines into `AdapterEvent` (ADR 0007). The working directory is the agent's first `readwrite` root (Phase 5), else the connection's working directory, else `<userData>/workspaces/<conversationId>`. The harness keeps the conversation history and is resumed by `harnessSessionId`; without one, or when the harness lost it, the history is replayed into a new session. The harness runs isolated from the user's own CLI settings and MCP servers, with only its own login. From Phase 5, the runner writes a temporary MCP configuration with the agent's servers and passes it to the binary (Claude Code `--mcp-config`; Codex `-c mcp_servers.…`). Write approval: the harness runs with auto-accept and the agent's policy is enforced by the built-in `filesystem` server, which asks the shell for approval through the runner itself. The harness's native file tools are disabled when possible (Claude Code: `--tools`), so every write goes through the built-in server. When that is not possible (Codex's `apply_patch`), the connection form warns the user. Codex streams one message at a time (its `exec --json` has no token deltas).

#### 4.3 Tools and permissions

- The runner keeps one MCP client per enabled `ToolServer`, started on demand and reused across runs.
- Built-in **`filesystem`** server: receives the agent's roots and modes as arguments; exposes `list`, `read`, `search`, `write`, `create`, `move`, `delete`. Any path outside the roots is rejected in the server, not only in the UI. Write operations emit an approval request, unless `allow-always` is already recorded for that agent and tool.
- Built-in **`google-drive`** server: OAuth done by the desktop (loopback), tokens in `safeStorage`, injected via env when starting the server. Exposes `search`, `read` (with Google Docs/Sheets export to text), `create`, `update`, `move`. Writes follow the same approval policy.
- Third-party servers: tools classified by `readOnlyHint`/`destructiveHint` (MCP annotations) to decide whether they ask for approval; without annotations, they ask.
- In the UI: each tool call is a collapsible block with name, arguments, result and duration. An approval request is an inline card with **Allow**, **Deny**, **Always allow for this agent**. While waiting, the conversation is `awaiting-approval` and the sidebar flags it.

#### 4.4 Boundaries

- Renderer → `Backend` (interface): `LocalBackend` over IPC today; `RemoteBackend` over HTTP + WebSocket in Phase 8. The UI knows nothing beyond `Backend`.
- Main → `RunnerClient`: the single point that talks to the runner process. Persists events, resolves secrets, handles restarts.
- Hub → runs only API connections and `http` MCP servers. `stdio` servers and CLI harnesses only exist on desktops. An online desktop can register as the **workspace runner** (Phase 9+) to execute those on behalf of the team.

### 5. User interface

Three columns, Slack style:

- **Sidebar**: agents with avatar, status (idle / responding / awaiting approval / error) and unread count. Shortcuts to Connections, Tools, Usage, Settings.
- **Center**: conversations of the selected agent and the open chat. Markdown, code with copy, collapsible tool blocks, approval cards, streaming cursor, cancel, retry.
- **Right panel**: agent details with editable role, active roots and tools, conversation usage.
- **Composer**: Enter sends, Shift+Enter adds a line break, text and image attachments, `Cmd/Ctrl+K` to switch agent or conversation.
- Light/dark theme; i18n from the start (en, pt-BR).

### 6. Roadmap

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Monorepo, docs, CI, **spike**: minimal runner with Anthropic adapter + Electron showing two conversations streaming in parallel with cancel | Spike works; architecture decision confirmed in an ADR |
| 1 | Complete API connections, secure secrets, connections screen | Four providers test and list models |
| 2 | CLI harnesses (Claude Code, Codex), session resume | A turn with streaming and cancellation in both |
| 3 | Agents: CRUD, role, model, avatar | Agent shows up in the sidebar |
| 4 | Full chat with parallelism, persistence, retry, auto-title | Two agents respond at the same time |
| 5 | Tools: `ToolServer`, MCP client in the runner, tool loop for APIs, `filesystem` server with roots and approvals, MCP passthrough to harnesses | Agent reads and creates a file in an allowed directory, a write asks for approval, outside the root is denied |
| 5b | Google Drive: OAuth, built-in server, registering third-party MCP servers in the UI | Agent reads a Google Doc and creates another one with approval |
| 6 | Usage: records, pricing, dashboard, export | Dashboard matches the records |
| 7 | Polish and v0.1.0: attachments, search, export/import, i18n, packaging, auto-update | Release published |
| 8 | Laravel hub: auth, workspaces, sync of agents and conversations, Reverb, `RemoteBackend` in the desktop | Two desktops see the same conversation live |
| 9 | Web: same UI served by the hub, API and `http` MCP execution in the hub, team keys; desktop as workspace runner | A user without the desktop talks to a team API agent |
| 10 | Usage policies: limits, concurrency, fallback and connection switching | Agent switches connection when it hits a limit |

### 7. Decisions

Resolved in Phase 0 (see `docs/adr/`): name **Comitiva** and license **Apache-2.0** (ADR 0001); the runner runs as **Electron in Node mode via `ELECTRON_RUN_AS_NODE`** (ADR 0002); desktop ORM **Drizzle** (ADR 0003); canonical blocks in the Anthropic format (ADR 0004); JSON Schema generated with zod 4 (ADR 0005).

Resolved in Phase 1: on Linux without a keyring (Chromium's `basic_text` backend), Comitiva **refuses** to store API keys and explains how to get a keyring; connections without a key (Ollama, LM Studio) keep working. Obfuscated storage is only for tests and CI (`COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1`).

Still open: implementation of the `google-drive` server (own vs community), decided in Phase 5b.

---
