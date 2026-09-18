# Comitiva — Technical Design

> `SPEC.md` says **what**; this document says **how**: step-by-step bootstrapping, file layout, data model, main classes and methods, flows, commands. It is written to be read by Claude Code together with `SPEC.md`; phase prompts should reference it.
>
> Signatures are skeletons: names and responsibilities matter, implementation details are left to each phase.

---

## 1. How to bootstrap the project (Phase 0, step by step)

### 1.1 Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 22 LTS | runner and Electron |
| pnpm | 9+ | workspaces |
| Git | any | |
| Python 3 + build tools (Xcode CLT / VS Build Tools / `build-essential`) | | compile `better-sqlite3` |
| Claude Code, Codex CLI | optional | test harnesses in Phase 2 |

### 1.2 Command sequence

```bash
# 1. Repository
mkdir comitiva && cd comitiva && git init
pnpm init
echo "node-linker=hoisted" > .npmrc        # electron-builder and native modules prefer hoisted

# 2. Workspaces
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - packages/*
  - apps/*
EOF
mkdir -p packages/{contract,runner,mcp-servers} apps/desktop docs/adr

# 3. Root tooling
pnpm add -Dw typescript turbo eslint prettier @eslint/js typescript-eslint \
  eslint-config-prettier vitest @types/node

# 4. contract package
cd packages/contract && pnpm init && pnpm add zod && pnpm add -D zod-to-json-schema tsup && cd ../..

# 5. runner package
cd packages/runner && pnpm init && pnpm add @anthropic-ai/sdk @modelcontextprotocol/sdk openai \
  @google/genai zod pino && pnpm add -D tsup msw && cd ../..

# 6. Built-in MCP servers
cd packages/mcp-servers && pnpm init && pnpm add @modelcontextprotocol/sdk zod && pnpm add -D tsup && cd ../..

# 7. Desktop (electron-vite scaffold inside the monorepo)
pnpm create @quick-start/electron@latest apps/desktop -- --template react-ts
cd apps/desktop
pnpm add better-sqlite3 zustand react-markdown remark-gfm @tanstack/react-virtual i18next react-i18next
pnpm add -D @types/better-sqlite3 tailwindcss @tailwindcss/vite @electron/rebuild electron-builder \
  @playwright/test
cd ../..

# 8. Native module compiled for the Electron version
pnpm --filter desktop exec electron-rebuild -f -w better-sqlite3

# 9. First commit
git add -A && git commit -m "chore: bootstrap monorepo"
```

### 1.3 Root configuration files

`package.json` (root):

```json
{
  "name": "comitiva",
  "private": true,
  "scripts": {
    "dev": "turbo run dev --filter=desktop",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "contract:schema": "pnpm --filter @comitiva/contract run schema",
    "runner:dev": "pnpm --filter @comitiva/runner run dev",
    "package": "pnpm --filter desktop run package"
  }
}
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", "out/**", "schema/**"] },
    "dev": { "cache": false, "persistent": true, "dependsOn": ["^build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json` (extended by every package):

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "skipLibCheck": true, "esModuleInterop": true, "resolveJsonModule": true, "isolatedModules": true
  }
}
```

Build order: `contract` → `runner` and `mcp-servers` → `desktop`. `turbo` resolves this through `dependsOn: ["^build"]`.

### 1.4 Package names

| Directory | `name` | Publishable |
|---|---|---|
| packages/contract | `@comitiva/contract` | yes (the Laravel hub consumes `schema/`) |
| packages/runner | `@comitiva/runner` | yes (bin `comitiva-runner`) |
| packages/mcp-servers | `@comitiva/mcp-servers` | yes (bins `comitiva-mcp-filesystem`, `comitiva-mcp-gdrive`) |
| apps/desktop | `desktop` | no |

### 1.5 Phase 0 exit checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` green
- [ ] `pnpm dev` opens a window; `window.api.app.getVersion()` returns the version via IPC
- [ ] runner starts as a child process and answers `ping`
- [ ] spike: two Anthropic responses streaming simultaneously, independent cancel
- [ ] runner event → paint latency measured and recorded in `docs/STATUS.md`
- [ ] ADRs: ORM, license, runner execution, canonical block format
- [ ] CI green on mac/win/linux

---

## 2. File layout

```
packages/contract/src/
├── index.ts
├── entities/          connection.ts agent.ts conversation.ts message.ts tool-server.ts
│                      tool-approval.ts usage-record.ts usage-policy.ts
├── blocks.ts          Block = TextBlock | ImageBlock | DocumentBlock | ToolUseBlock | ToolResultBlock
├── provider-config.ts ConnectionConfig discriminated union per provider
├── runner-protocol.ts RunnerRequest, RunnerEvent
├── ipc.ts             desktop IPC contract (channels + input/output schemas)
└── schema.ts          script: zod → JSON Schema in ../schema/*.json

packages/runner/src/
├── bin.ts             entry: new RunnerServer(process.stdin, process.stdout).start()
├── server/            RunnerServer.ts Transport.ts RequestRouter.ts
├── runs/              RunManager.ts Run.ts ToolLoop.ts PermissionGate.ts
├── providers/         ProviderRegistry.ts ProviderAdapter.ts
│   ├── api/           AnthropicAdapter.ts OpenAICompatibleAdapter.ts GoogleAdapter.ts OllamaAdapter.ts
│   └── cli/           CliHarnessAdapter.ts ClaudeCodeAdapter.ts CodexAdapter.ts parsers/
├── mcp/               McpClientManager.ts McpClient.ts ToolCatalog.ts
├── usage/             UsageCalculator.ts pricing.json Tokenizer.ts
├── client/            RunnerClient.ts        (embedded by shells)
└── util/              jsonl.ts errors.ts logger.ts

packages/mcp-servers/src/
├── filesystem/        server.ts RootGuard.ts tools/*.ts approval.ts
└── google-drive/      server.ts drive-api.ts tools/*.ts

apps/desktop/src/
├── main/
│   ├── index.ts                 bootstrap: app.whenReady → Database → RunnerSupervisor → IpcRouter → window
│   ├── runner/                  RunnerSupervisor.ts
│   ├── db/                      Database.ts migrations/0001_init.sql ... repositories/*.ts
│   ├── secrets/                 SecretStore.ts ElectronSecretStore.ts
│   ├── services/                ConversationService.ts AgentService.ts ConnectionService.ts
│   │                            ToolServerService.ts ApprovalService.ts UsageService.ts TitleService.ts
│   ├── ipc/                     IpcRouter.ts handlers/*.ts
│   └── oauth/                   GoogleOAuth.ts (Phase 5b)
├── preload/index.ts             exposes a typed window.api derived from contract/ipc.ts
└── renderer/src/
    ├── backend/                 Backend.ts LocalBackend.ts (RemoteBackend.ts in Phase 8)
    ├── store/                   agents.ts conversations.ts messages.ts ui.ts
    ├── components/              Sidebar/ Chat/ Composer/ ToolBlock/ ApprovalCard/ Forms/ Settings/
    ├── screens/                 ChatScreen ConnectionsScreen ToolsScreen UsageScreen SettingsScreen
    └── i18n/                    en.json pt-BR.json
```

---

## 3. Data model

### 3.1 Diagram

```mermaid
erDiagram
    CONNECTION ||--o{ AGENT : "uses"
    AGENT ||--o{ CONVERSATION : "has"
    CONVERSATION ||--o{ MESSAGE : "contains"
    AGENT }o--o{ TOOL_SERVER : "enables (agent_tool_server)"
    AGENT ||--o{ AGENT_ROOT : "roots"
    CONVERSATION ||--o{ TOOL_APPROVAL : "approvals"
    MESSAGE ||--o{ USAGE_RECORD : "generates"
    CONNECTION ||--o{ USAGE_RECORD : "consumption"
    CONNECTION ||--o| USAGE_POLICY : "limit (Phase 10)"

    CONNECTION { text id PK; text name; text kind; text provider; json config; text secret_ref; int enabled; text created_at; text updated_at }
    AGENT { text id PK; text name; text avatar; text connection_id FK; text model; text role; json params; text permission_policy; json fallback_connection_ids; json tags; text created_at; text updated_at }
    AGENT_ROOT { text agent_id FK; text path; text mode }
    TOOL_SERVER { text id PK; text name; text transport; text command; json args; json env; text url; json headers; int builtin; int enabled }
    CONVERSATION { text id PK; text agent_id FK; text title; text status; text harness_session_id; int archived; text last_activity_at; text created_at }
    MESSAGE { text id PK; text conversation_id FK; text role; json content; text status; int seq; text created_at }
    TOOL_APPROVAL { text id PK; text conversation_id FK; text agent_id; text tool_server_id; text tool_name; text tool_use_id; json input; text decision; text decided_at }
    USAGE_RECORD { text id PK; text connection_id FK; text agent_id; text conversation_id; text message_id; text model; int input_tokens; int output_tokens; int cache_read_tokens; int cache_write_tokens; int estimated; real cost_usd; int latency_ms; text created_at }
    USAGE_POLICY { text connection_id PK; int max_tokens_day; real max_cost_day; int max_concurrent; text window_start; text window_end }
```

### 3.2 Initial DDL (SQLite, migration 0001)

```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('api','cli')),
  provider TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE tool_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  command TEXT, args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}',
  url TEXT, headers TEXT NOT NULL DEFAULT '{}', builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  model TEXT, role TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}',
  permission_policy TEXT NOT NULL DEFAULT 'ask',
  fallback_connection_ids TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_agents_connection ON agents(connection_id);

CREATE TABLE agent_roots (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  path TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('read','readwrite')),
  PRIMARY KEY (agent_id, path)
);

CREATE TABLE agent_tool_servers (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_server_id TEXT NOT NULL REFERENCES tool_servers(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, tool_server_id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT, status TEXT NOT NULL DEFAULT 'idle',
  harness_session_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_agent ON conversations(agent_id, archived, last_activity_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'complete',
  seq INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_messages_conv_seq ON messages(conversation_id, seq);

CREATE TABLE tool_approvals (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL, tool_server_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  tool_use_id TEXT NOT NULL, input TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','allow-always')), decided_at TEXT NOT NULL
);
CREATE INDEX idx_approvals_always ON tool_approvals(agent_id, tool_server_id, tool_name) WHERE decision = 'allow-always';

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0, cost_usd REAL, latency_ms INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_conn_time ON usage_records(connection_id, created_at);
CREATE INDEX idx_usage_agent_time ON usage_records(agent_id, created_at);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

Conventions: ids are ULIDs (sortable); dates are ISO 8601 UTC; JSON in TEXT columns is validated by zod on read and write; `seq` in `messages` is incremented per conversation and is used for ordering and for reconciliation with the hub.

### 3.3 Message blocks (canonical)

```ts
type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { kind: 'base64'; mediaType: string; data: string } | { kind: 'file'; path: string } }
  | { type: 'document'; name: string; mediaType: string; source: /* same */ }
  | { type: 'tool_use'; id: string; toolServerId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: Block[]; isError: boolean; durationMs?: number };
```

An `assistant` message can mix `text` and `tool_use`; the following `tool` message carries the `tool_result`s. Adapters translate to the provider's format (OpenAI uses `tool_calls`/`role: tool`; Gemini uses `functionCall`/`functionResponse`).

---

## 4. Runner

### 4.1 Lifecycle

```mermaid
sequenceDiagram
    participant M as Electron main (RunnerSupervisor)
    participant R as Runner (RunnerServer)
    M->>R: spawn(execPath, [runner.js], { env: ELECTRON_RUN_AS_NODE=1 })
    M->>R: {"id":"1","type":"ping"}
    R-->>M: {"type":"response","id":"1","ok":true,"result":{"version":"0.1.0"}}
    Note over M,R: from here on, requests and events flow as JSON lines
    R--xM: process dies
    M->>M: backoff (1s, 2s, 4s… max 30s), mark active runs as error(retryable)
    M->>R: spawn again
```

### 4.2 Classes

```ts
// server/Transport.ts — JSON lines over streams
class JsonLinesTransport {
  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream);
  onMessage(handler: (msg: unknown) => void): void;
  send(msg: RunnerEvent): void;        // serializes + '\n'; never throws
}

// server/RunnerServer.ts
class RunnerServer {
  constructor(transport: JsonLinesTransport, deps: { registry: ProviderRegistry; mcp: McpClientManager; runs: RunManager });
  start(): void;                        // validates each line with the RunnerRequest schema, dispatches to RequestRouter
  stop(): Promise<void>;                // cancels runs, closes MCP clients
}

// server/RequestRouter.ts
class RequestRouter {
  handle(req: RunnerRequest): Promise<unknown>;   // switch on req.type → matching method
  // connection.test → registry.get(provider).testConnection
  // connection.listModels → registry.get(provider).listModels
  // toolServer.start/stop → mcp.start/stop
  // run.start → runs.start ; run.cancel → runs.cancel ; run.approval → runs.resolveApproval
}

// runs/RunManager.ts — one Run per runId, all concurrent
class RunManager {
  start(req: RunStartRequest): void;                 // creates Run, does not block
  cancel(runId: string): void;                       // AbortController.abort()
  resolveApproval(runId: string, toolUseId: string, decision: ApprovalDecision): void;
  active(): string[];
}

// runs/Run.ts
class Run {
  constructor(req: RunStartRequest, adapter: ProviderAdapter, tools: ToolCatalog, gate: PermissionGate, emit: (e: RunnerEvent) => void);
  execute(): Promise<void>;
  // builds RunInput, creates RunContext { tools, callTool }, iterates adapter.run(...)
  // translates AdapterEvent → RunnerEvent with runId; measures latency; collects usage
  private callTool(toolUseId: string, name: string, input: unknown): Promise<ToolResult>;
  // → gate.check(...) → if approval is needed, emits run.tool_call{requiresApproval:true} and awaits a promise
  // → tools.call(...) → emits run.tool_result
}

// runs/ToolLoop.ts — used by the API adapters
async function* toolLoop(opts: {
  callModel: (messages: Message[], tools: ToolDef[], signal: AbortSignal) => AsyncIterable<AdapterEvent>;
  ctx: RunContext; messages: Message[]; maxIterations: number; signal: AbortSignal;
}): AsyncIterable<AdapterEvent>
// loop: call model → accumulate tool_use → for each, ctx.callTool → append tool_result → repeat until stopReason != 'tool_use'

// runs/PermissionGate.ts
class PermissionGate {
  constructor(policy: PermissionPolicy, alwaysAllowed: Set<string> /* `${serverId}:${tool}` */);
  check(tool: ToolDef): 'allow' | 'ask' | 'deny';
  // read-only (annotations.readOnlyHint) → allow
  // policy read-only + tool not read-only → deny
  // allow-always recorded → allow ; policy allow-writes → allow ; otherwise ask
}
```

```ts
// providers/ProviderAdapter.ts
interface ProviderAdapter {
  readonly id: ProviderId;
  readonly kind: 'api' | 'cli';
  readonly capabilities: Capabilities;
  testConnection(config: ConnectionConfig, secret?: string): Promise<TestResult>;
  listModels?(config: ConnectionConfig, secret?: string): Promise<ModelInfo[]>;
  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent>;
}

interface RunContext {
  tools: ToolDef[];                                            // aggregated from the agent's servers
  callTool(toolUseId: string, name: string, input: unknown): Promise<ToolResult>;
  mcpConfigForCli(): Promise<{ path: string; cleanup(): void }>; // temporary file for harnesses
  log(level: 'debug' | 'info' | 'warn', msg: string): void;
}

// providers/ProviderRegistry.ts
class ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  get(id: ProviderId): ProviderAdapter;                        // throws UnknownProviderError
  list(): ProviderDescriptor[];                                // used by the UI to build forms
}

// providers/api/AnthropicAdapter.ts (pattern for the others)
class AnthropicAdapter implements ProviderAdapter {
  private client(config, secret): Anthropic;
  private toProviderMessages(messages: Message[]): MessageParam[];   // Block[] → Anthropic format
  private toProviderTools(tools: ToolDef[]): Tool[];
  run(input, ctx, signal) { return toolLoop({ callModel: (m, t, s) => this.stream(m, t, s), ... }); }
  private async *stream(...): AsyncIterable<AdapterEvent>;          // SDK stream → text_delta/tool_use/usage/done
}

// providers/cli/CliHarnessAdapter.ts
abstract class CliHarnessAdapter implements ProviderAdapter {
  kind = 'cli' as const;
  protected abstract buildArgs(input: RunInput, mcpConfigPath?: string): string[];
  protected abstract parseLine(line: string): AdapterEvent[];    // one JSON line → zero or more events
  protected abstract versionArgs(): string[];
  protected locateBinary(config: CliConfig): Promise<string>;     // config.binaryPath || which()
  protected spawn(bin, args, opts: { cwd; env; signal }): ChildProcess;
  async *run(input, ctx, signal) { /* mcp config → spawn → readline stdout → parseLine → yield; stderr → error */ }
  async testConnection(config) { /* locate → --version → minimal prompt */ }
}
class ClaudeCodeAdapter extends CliHarnessAdapter { /* -p, --output-format stream-json, --resume, --mcp-config */ }
class CodexAdapter extends CliHarnessAdapter { /* exec --json ... verified via --help */ }
```

```ts
// mcp/McpClientManager.ts
class McpClientManager {
  start(server: ToolServer, secrets: Record<string, string>): Promise<ToolDef[]>;  // idempotent
  stop(serverId: string): Promise<void>;
  catalogFor(serverIds: string[]): ToolCatalog;
  private restartOnFailure(serverId: string): void;
}

// mcp/ToolCatalog.ts — aggregated view for a run
class ToolCatalog {
  defs(): ToolDef[];                                            // prefixed names: `${serverSlug}__${tool}` to avoid collisions
  call(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult>;
  resolve(name: string): { serverId: string; tool: ToolDef };
}

// usage/UsageCalculator.ts
class UsageCalculator {
  constructor(pricing: PricingTable, overrides?: PricingTable);
  cost(model: string, usage: TokenUsage): number | null;
  estimate(messages: Message[], output: string): TokenUsage;   // approximate fallback, estimated=true
}

// client/RunnerClient.ts — what shells embed
class RunnerClient extends EventEmitter {
  constructor(opts: { spawn: () => ChildProcess; requestTimeoutMs?: number });
  start(): Promise<void>;                                       // spawn + ping
  request<T>(req: Omit<RunnerRequest, 'id'>): Promise<T>;       // correlates by id
  startRun(req: RunStartPayload): { runId: string };
  cancelRun(runId: string): void;
  approve(runId: string, toolUseId: string, decision: ApprovalDecision): void;
  on(event: 'run.event', h: (e: RunnerEvent) => void): this;
  on(event: 'crash', h: (code: number | null) => void): this;
  stop(): Promise<void>;
}
```

### 4.3 Flow of a turn with a tool and approval

```mermaid
sequenceDiagram
    actor U as User
    participant UI as Renderer
    participant CS as ConversationService (main)
    participant RC as RunnerClient
    participant R as Run (runner)
    participant A as Adapter (API)
    participant FS as MCP filesystem

    U->>UI: sends "reorganize the reports"
    UI->>CS: sendMessage(convId, blocks)
    CS->>CS: persists user msg; status=running
    CS->>RC: run.start {agent, connection, secret, messages, alwaysAllowed}
    RC->>R: JSON line
    R->>A: run(input, ctx)
    A-->>R: text_delta*
    R-->>CS: run.text_delta (batched in CS every ~50ms)
    CS-->>UI: stream
    A-->>R: tool_use fs__list_dir
    R->>R: gate.check → allow (read-only)
    R->>FS: tools/call list_dir
    FS-->>R: result
    R-->>CS: run.tool_call{requiresApproval:false}, run.tool_result
    A-->>R: tool_use fs__move
    R->>R: gate.check → ask
    R-->>CS: run.tool_call{requiresApproval:true}
    CS->>CS: status=awaiting-approval
    CS-->>UI: ApprovalCard
    U->>UI: "Always allow"
    UI->>CS: approve(convId, toolUseId, 'allow-always')
    CS->>CS: stores tool_approval
    CS->>RC: run.approval
    RC->>R: JSON line → promise resolved
    R->>FS: tools/call move
    FS-->>R: ok
    R-->>CS: run.tool_result
    A-->>R: text_delta* , done, usage
    R-->>CS: run.usage, run.done
    CS->>CS: persists assistant/tool msg, usage_record; status=idle
    CS-->>UI: done
```

Batching: `ConversationService` accumulates `text_delta` and writes to SQLite every ~250 ms or at the end of the run; to the UI, it forwards every ~50 ms. Never one `UPDATE` per token.

---

## 5. Built-in MCP servers

```ts
// mcp-servers/src/filesystem/RootGuard.ts
class RootGuard {
  constructor(roots: Array<{ path: string; mode: 'read' | 'readwrite' }>);
  resolve(requested: string, op: 'read' | 'write'): string;
  // realpath of the candidate AND of each root; requires realpath(candidate) to start with realpath(root) + sep
  // for write, requires a readwrite root; for paths that do not exist yet, validates the parent directory
  // throws OutsideRootsError / ReadOnlyRootError — never returns a path outside the roots
}

// mcp-servers/src/filesystem/server.ts — arguments: --root <path>:<mode> (repeatable)
// tools: list_dir, read_file, search (glob + content), write_file, create_dir, move, delete
// annotations: list_dir/read_file/search → readOnlyHint:true ; delete/move → destructiveHint:true
// approval: the server does NOT approve anything; the runner decides before calling tools/call (PermissionGate).
// For CLI harnesses that call the server directly, the server receives --approval-socket <path>
// and asks the runner over a local socket before executing writes (Phase 5, design to be confirmed).
```

```ts
// mcp-servers/src/google-drive/server.ts — tokens via env GDRIVE_ACCESS_TOKEN (refreshed by the desktop)
// tools: search, read (Docs → text/markdown, Sheets → CSV), create (doc/text), update, move
// analogous annotations
```

---

## 6. Desktop — main process

```ts
// main/runner/RunnerSupervisor.ts
class RunnerSupervisor {
  constructor(deps: { onEvent: (e: RunnerEvent) => void; runnerEntry: string });
  client: RunnerClient;
  start(): Promise<void>;         // spawn with process.execPath and ELECTRON_RUN_AS_NODE=1 (ADR), or embedded node
  private onCrash(): void;        // backoff, restart, notify services to mark runs as error
  stop(): Promise<void>;
}

// main/db/Database.ts
class Database {
  static open(path: string): Database;   // WAL, foreign_keys=ON, busy_timeout
  migrate(): void;                       // applies migrations/*.sql in order, records in schema_migrations
  transaction<T>(fn: () => T): T;
  raw: BetterSqlite3.Database;
}

// main/db/repositories/*.ts — common pattern
interface Repository<T, Create, Update> {
  list(filter?): T[]; get(id): T | null; create(data: Create): T; update(id, data: Update): T; delete(id): void;
}
class ConnectionRepository implements Repository<Connection, ...> { /* + hasAgents(id) */ }
class AgentRepository { /* + roots/toolServers loaded together; alwaysAllowed(agentId) */ }
class ConversationRepository { /* + listByAgent(agentId, {archived}); setStatus; setHarnessSession; touch */ }
class MessageRepository { /* + listByConversation(id, {limit, before}); appendText(id, text); setContent; setStatus; nextSeq */ }
class ToolServerRepository, ToolApprovalRepository, UsageRepository { /* summary(range, groupBy); timeseries */ }

// main/secrets/SecretStore.ts
interface SecretStore {
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}
class ElectronSecretStore implements SecretStore {
  // safeStorage.encryptString → file <userData>/secrets.bin (JSON { ref: base64 }), atomic write (tmp + rename)
  // refuses to operate if !safeStorage.isEncryptionAvailable()
}

// main/services/ConversationService.ts
class ConversationService extends EventEmitter {
  constructor(deps: { db; conversations; messages; agents; connections; approvals; usage; secrets; runner: RunnerClient; title: TitleService });
  create(agentId: string): Conversation;
  sendMessage(conversationId: string, content: Block[]): Promise<void>;
  cancel(conversationId: string): void;
  retryLast(conversationId: string): Promise<void>;
  approve(conversationId: string, toolUseId: string, decision: ApprovalDecision): void;
  private buildRunRequest(conv: Conversation): RunStartPayload;      // agent + connection + secret + history + alwaysAllowed
  private handleRunnerEvent(e: RunnerEvent): void;                   // dispatches by type; keeps a runId → conversationId map
  private flushText(conversationId: string): void;                   // batching for SQLite
  // events emitted to IpcRouter: 'conversation.updated', 'message.delta', 'message.block', 'message.completed', 'approval.requested'
}

// main/ipc/IpcRouter.ts
class IpcRouter {
  constructor(services, windowManager);
  register(): void;   // for each channel in contract/ipc.ts: ipcMain.handle(channel, (e, input) => schema.parse(input) → service)
  broadcast(channel: string, payload: unknown): void;   // webContents.send to all windows
}
```

IPC channels (defined in `contract/ipc.ts`, all with input and output schemas):

```
app.getVersion
connections.list | create | update | delete | test | listModels
toolServers.list | create | update | delete | test | connectGoogle (5b)
agents.list | create | update | delete | duplicate
conversations.listByAgent | create | rename | archive | setStatus
messages.list | send | cancel | retry
approvals.decide
usage.summary | timeseries | export
dialogs.pickFolder
events: conversation.updated, message.delta, message.block, message.completed, approval.requested, runner.status
```

---

## 7. Desktop — renderer

```ts
// renderer/src/backend/Backend.ts — the UI only knows this
interface Backend {
  capabilities(): { cliHarnesses: boolean; localRoots: boolean; hub: boolean };
  connections: { list(); create(d); update(id, d); delete(id); test(id); listModels(id) };
  toolServers: { list(); create(d); update(id, d); delete(id); test(id) };
  agents: { list(); create(d); update(id, d); delete(id); duplicate(id) };
  conversations: { listByAgent(agentId); create(agentId); rename(id, t); archive(id) };
  messages: { list(convId, opts?); send(convId, blocks); cancel(convId); retry(convId) };
  approvals: { decide(convId, toolUseId, decision) };
  usage: { summary(range, groupBy); timeseries(range) };
  onEvent(handler: (e: BackendEvent) => void): () => void;
}
class LocalBackend implements Backend { /* delegates to window.api; onEvent subscribes to the event channels */ }

// renderer/src/store/*.ts (Zustand)
useAgentsStore:         agents[], selectedAgentId, statusByAgent (derived from conversations), unreadByAgent
useConversationsStore:  byAgent: Record<agentId, Conversation[]>, selectedByAgent
useMessagesStore:       byConversation: Record<convId, Message[]>, streamingText: Record<convId, string>,
                        applyDelta(convId, text), applyBlock(convId, block), complete(convId, message)
useUiStore:             rightPanelOpen, theme, quickSwitcherOpen, pendingApprovals: Record<convId, ToolCallEvent>
```

Main components: `Sidebar/AgentList`, `Sidebar/AgentItem` (status dot + badge), `Chat/ConversationList`, `Chat/MessageList` (virtualized), `Chat/MessageBubble`, `ToolBlock/ToolCallBlock`, `ApprovalCard`, `Composer`, `QuickSwitcher`, `Forms/ConnectionForm` (renders fields from `ProviderDescriptor`), `Forms/AgentForm`, `Forms/ToolServerForm`, `Settings/*`, `Usage/*`.

---

## 8. Everyday commands

```bash
pnpm dev                      # desktop in dev (hot reload in the renderer, restart of main)
pnpm runner:dev               # runner alone: echo JSON lines into stdin to test
echo '{"id":"1","type":"ping"}' | pnpm --filter @comitiva/runner exec tsx src/bin.ts

pnpm test                     # everything
pnpm --filter @comitiva/runner test -- --watch
pnpm --filter desktop exec playwright test

pnpm contract:schema          # regenerates packages/contract/schema/*.json (commit it)
pnpm --filter desktop exec electron-rebuild -f -w better-sqlite3   # after changing the Electron version

pnpm package                  # electron-builder for the current platform
pnpm --filter desktop run package -- --mac --win --linux           # with CI or installed toolchains

# Inspecting the local database
sqlite3 "$HOME/Library/Application Support/comitiva/comitiva.db" '.tables'   # macOS
# Linux: ~/.config/comitiva/ ; Windows: %APPDATA%\comitiva\
```

Debugging the runner: `AGENTDESK_RUNNER_LOG=debug pnpm dev` makes the runner log to stderr (never to stdout, which is the protocol channel). Main writes that stderr to `<userData>/logs/runner.log` with rotation.

---

## 9. Conventions

- **Errors**: `AppError { code: string; message; retryable; cause? }` class in `contract`; adapters map provider errors to stable codes (`auth_failed`, `rate_limited`, `provider_unavailable`, `binary_not_found`, `not_logged_in`, `outside_roots`, `approval_denied`). The UI translates by code (i18n), never shows a raw provider message as a title.
- **Logs**: `pino` in the runner and in main; levels via env; no message content in logs at `info` level.
- **Secrets**: only `secretRef` in the database and in IPC payloads; the renderer never receives a secret value; the runner receives the value per request and does not persist it.
- **Tests**: runner and mcp-servers with vitest and mocks (msw for HTTP, fake in-memory MCP server, fake shell binary for CLI); desktop main with in-memory SQLite; renderer with testing-library; Playwright for the two-parallel-conversations flow with a mock provider.
- **Commits**: conventional commits; scope = package (`feat(runner): ...`, `fix(desktop): ...`).
- **ADR**: one per decision that affects more than one package; format: context, decision, consequences.

---

## 10. Implementation order within each phase

General rule: **contract → runner → main → renderer**, with tests at each layer before moving on to the next. A topic is only "done" when Playwright or an integration test exercises the whole path. This applies to every phase and must be stated in `CLAUDE.md`.

---

## 11. Use by Claude Code

Every phase prompt says to read this document together with `SPEC.md`. When the code diverges from it for a good reason, the document is updated in the same commit; it never goes silently out of date.
