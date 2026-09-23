# Providers

How to connect each LLM Comitiva supports, what each one can do, and how to fix the usual errors. The second half is for contributors: [adding a provider adapter](#adding-a-provider-adapter) and [CLI harnesses](#cli-harnesses).

A **connection** is a way to reach a model: an API with a key (or none, for local servers), or a command-line harness that uses its own login. Open **Connections → Add connection**, pick the provider, fill in the form, press **Fetch models** (APIs) or **Detect** (harnesses), then **Test**, then **Save**. Keys go to the OS keychain (Electron `safeStorage`), never to the database or the renderer. On Linux you need a running keyring (GNOME Keyring or KWallet); without one, Comitiva refuses to store keys and says why.

## What each provider does

| Provider | Kind | Key | Streaming | Tools | Images | Resume | Models list | Usage |
|---|---|---|---|---|---|---|---|---|
| Anthropic | API | required | tokens | yes | yes | – | yes | exact, with cache |
| OpenAI-compatible | API | per preset | tokens | yes | yes¹ | – | yes | exact when the server reports it |
| Google Gemini | API | required | tokens | yes | yes | – | yes | exact, thinking counted as output |
| Ollama | API | optional | tokens | yes² | yes¹ | – | yes | exact |
| Claude Code | CLI | its login | tokens | yes, through the proxy | no → note | session | – | exact, cost reported by the harness |
| Codex | CLI | its login | whole messages | yes, through the proxy | no → note | session | – | exact |

¹ The provider takes images; whether a given model does depends on the model. A text-only model behind the endpoint answers with an error, shown by code.
² Tools need a model that supports them (for example `llama3.1`, `qwen2.5`).

**Attachments** (the composer's paperclip, drag and drop, or paste): images (PNG, JPEG, GIF, WebP, up to 5 MB) and text files (UTF-8, up to 1 MB), ten per message.
- Text files go to every provider as text, inside a `<document name="…">` element. Anthropic gets them as a plain-text document block.
- Images go natively to the four API providers. A CLI harness does not get them: the model reads `[Image "x.png" attached but not sent: … does not accept images]` instead, and the composer warns before you send.
- Files are stored under `<userData>/attachments` and sent with the history on every turn (ADR 0012).

## Setting up each one

**Anthropic.** Paste an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). The base URL (under Advanced) is for gateways and proxies. Pick a default model, or set one per agent.

**OpenAI-compatible.** One adapter for any server that speaks the Chat Completions API. Presets fill the base URL:

| Preset | Base URL | Key |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| Groq | `https://api.groq.com/openai/v1` | required |
| LM Studio | `http://localhost:1234/v1` | none |
| Custom | yours (vLLM, LiteLLM, llama.cpp server, …) | optional |

The server must stream and, for usage, honor `stream_options.include_usage`; without it Comitiva estimates the tokens and marks them estimated.

**Google Gemini.** A Gemini API key from [aistudio.google.com](https://aistudio.google.com/apikey) (not Vertex AI). Thinking tokens count as output.

**Ollama.** Run `ollama serve` and pull a model (`ollama pull llama3.1`). The base URL defaults to `http://localhost:11434`. A key is only for a proxy in front of it. Local models cost nothing: their usage shows `$0.00`.

**Claude Code.** Install it and log in once in a terminal: `claude auth login`. **Detect** finds the binary on `PATH` and the usual install folders, or type its path. The working directory is where it works when the agent has no read-write folder. Comitiva runs it non-interactively with every action auto-accepted, isolated from your own Claude Code settings, hooks and MCP servers. With the agent's Files tool on, its own file tools are turned off, so every write asks you first.

**Codex.** Install it and log in: `codex login`. The **sandbox** setting is Codex's own (read-only, workspace-write, or full access). On Ubuntu 24.04 the workspace-write sandbox may not start (AppArmor restricts user namespaces); **Test** checks for that and says so. Codex cannot turn off its own file edits, so with the agent's Files tool on, Comitiva forces its sandbox read-only; without it, Codex's own edits do not ask you, and the form warns.

## When something fails

Errors are shown by code, in your language. The usual ones:

| Code | What it means | What to do |
|---|---|---|
| `auth_failed` | The provider refused the key | Paste the key again; check it has credit and access to the model |
| `rate_limited` | Too many requests | Wait and **Retry**; lower the concurrency on that key |
| `provider_unavailable` | No answer (refused, DNS, 5xx) | Check the base URL and that a local server is running |
| `provider_error` | The provider refused the request | Often an unknown model or a feature the model lacks (images, tools) |
| `timeout` | No answer in time | Retry; local models may need a smaller one |
| `model_required` | Neither the agent nor the connection names a model | Set a default model on the connection, or one on the agent |
| `secret_missing` | The connection needs a key it does not have (e.g. after an import) | Edit the connection and paste the key |
| `binary_not_found` | The harness is not installed where Comitiva looked | Install it, or type its full path and press **Detect** |
| `not_logged_in` | The harness has no login | Run the login command the error shows, in a terminal |
| `sandbox_unavailable` | Codex's sandbox cannot start | Pick the read-only sandbox, or allow user namespaces (see Codex above) |
| `unsupported_content` | Content the provider cannot take | Remove the attachment, or use a provider that takes it |

Every run's tokens and cost are on the **Usage** screen ([usage.md](usage.md)).

---

# Adding a provider adapter

How to teach the runner a new LLM API. The four API adapters (`anthropic`, `openai-compatible`, `google`, `ollama`) follow this recipe; use them as working examples. CLI harnesses follow a different base class, `CliHarnessAdapter`: see [CLI harnesses](#cli-harnesses) below.

Order, as everywhere in the repo: **contract → runner → (main and renderer need nothing) → tests**.

## 1. Contract: config and descriptor

In `packages/contract/src/provider-config.ts`:

- Add the id to `ProviderId`.
- Add a `XxxConfig` zod schema with the provider's settings (`baseUrl`, `defaultModel`, …). Secrets never go here.

In `packages/contract/src/entities/connection.ts`, add a variant to the `Connection` union (`kind: 'api'`, `provider: z.literal('xxx')`, `config: XxxConfig`).

In `packages/contract/src/ipc.ts`, add the variant to `apiProviderVariants`, so the IPC draft and probe schemas accept it.

In `packages/contract/src/providers.ts`, add a `providerDescriptors` entry. This is what the UI builds the form from, and the adapter's `capabilities` come from here:

```ts
xxx: {
  id: 'xxx',
  kind: 'api',
  label: 'Xxx',
  capabilities: { streaming: true, tools: true, resume: false, listModels: true, usage: true, images: false },
                                      // be honest: only what the adapter does today
  secret: 'required',                 // 'required' | 'optional' | 'none'
  baseUrl: { mode: 'advanced', default: 'https://api.xxx.com' },  // or mode 'required'
},
```

Then run `pnpm contract:schema` and commit the regenerated JSON.

The Connections form picks the provider up by itself: the provider list, the key field (required, optional or hidden), the base URL (always shown, or behind "Advanced"), fetch models and test. Only `ProviderIcon.tsx` needs a monogram for it.

## 2. Runner: the adapter

Create `packages/runner/src/providers/api/XxxAdapter.ts` implementing `ProviderAdapter` (`providers/ProviderAdapter.ts`):

```ts
export class XxxAdapter implements ProviderAdapter {
  readonly id = 'xxx' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors.xxx.capabilities;

  testConnection(connection, secret) {
    return probe((signal) => /* cheapest authenticated call */, toAppError);
  }
  listModels(connection, secret) {
    return withDeadline(async (signal) => /* → ModelInfo[] */, toAppError);
  }
  run(input, ctx, signal) {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal, usage, toAppError,
      body: () => toolLoop({
        ctx, usage, messages: input.messages, maxIterations: input.params.maxToolIterations,
        call: (messages, tools) => this.stream(input, messages, tools, usage, signal),
      }),
    });
  }
  /** One model call. */
  private async *stream(input, messages, tools, usage, signal): AsyncGenerator<AdapterEvent, StopReason> {
    // send `messages` (translated) and `tools` (when any) with `signal`;
    // yield { type: 'run.text_delta', text } as text streams, and each complete tool call as
    // { type: 'run.block', block: { type: 'tool_use', id, toolServerId: '', name, input } };
    // usage.report({ input, output, cacheRead, final: true }) when the provider says so;
    // return the mapped stop reason
  }
}
```

**Attachments**: translate the parts `userParts(m.content, { images: capabilities.images, provider })` returns — text and, when the provider takes them, images (`{ mediaType, data }` base64). Anthropic's `document` block and Ollama's `images` array are examples.

**Tools** (Phase 5, `docs/tools.md`): `toolLoop` (`runs/ToolLoop.ts`) runs the calls through `ctx.callTool` (gate, approvals, MCP), appends the assistant turn and a `tool` message with the results, and calls `stream` again. It fills `toolServerId`, sums usage across calls, and stops at the iteration limit. The adapter only translates:
- `ToolDef` → the provider's tool format. `inputSchema` is a JSON Schema object; add `type: 'object'`.
- `tool_use` blocks in `assistant` messages → the provider's tool calls. Keep `signature` if the provider needs it back (Gemini thought signatures).
- `tool_result` blocks in `tool` messages → the provider's results (`toolResultText` for text-only providers; results start with a stable code when they are errors).
- Streamed tool calls → complete `tool_use` blocks. Accumulate fragments by index, then parse the JSON with `parseJson`, which turns an empty or cut-off input into `{}`. Generate an id when the provider gives none.

Some providers end a turn with a plain stop even when it called tools (Ollama, Gemini): the loop goes by the tool calls, not the stop reason.

Register it in `createDefaultRegistry()` (`providers/ProviderRegistry.ts`).

The helpers in `providers/api/shared.ts` enforce the rules every adapter must follow:

| Rule | Helper |
|---|---|
| Every turn ends with exactly one `run.usage`, then `run.done`. Failures are thrown as `AppError`, and `Run` turns them into `run.error`. | `streamTurn` |
| Cancel is not an error. It yields the usage known so far (`estimated: true`) and `done { stopReason: 'cancelled' }` right away, even if the SDK keeps its stream open. | `streamTurn` (races every read against the signal) |
| `inputTokens` is always **net of `cacheReadTokens`**. Providers disagree — OpenAI's `prompt_tokens` and Gemini's `promptTokenCount` include the cached tokens, Anthropic's and both harnesses' do not — so the adapter subtracts before reporting. Without this, cost charges the cached tokens twice. | each adapter |
| Usage the provider does not report is estimated by `usage/Tokenizer.ts` (word, punctuation and CJK aware; tool-call and tool-result JSON counted; text documents counted as text; images and binary documents charged a flat rate). The tool loop re-seeds the prompt estimate before each model call. | `UsageTracker` |
| A turn that **fails** still yields its usage before throwing: the tokens were spent and the provider bills them. | `streamTurn` |
| Report `model` when the provider names what it ran, and `costUsd` when the harness computed one. | each adapter |
| HTTP errors map to stable codes: 401/403 → `auth_failed`; 429 → `rate_limited` (retryable); 5xx → `provider_unavailable` (retryable); other 4xx → `provider_error`. | `httpError` |
| No response (refused, DNS, reset) → `provider_unavailable` (retryable). A timeout → `timeout` (retryable). | `networkError`, `isFetchFailure` |
| Test and list models give up after 15 s with `timeout`. `testConnection` never throws; it returns `{ ok: false, error }`. | `withDeadline`, `probe` |
| Attachments (ADR 0012): text documents become text, images go natively where `capabilities.images` holds and become a note elsewhere, other binaries become a note. A `file` source is `invalid_request`: the shell resolves it before the run. | `providers/media.ts` (`userParts`, `textOf`) |

Your own `toAppError(err)` should check the SDK's error classes first (timeout before connection error), then fall back to `httpError(status, …)`, `networkError`, and finally `AppError.from`.

### Non-negotiables

- **Explicit credentials and endpoint.** Pass the key and the base URL explicitly, and null out any other credential option the SDK has. Most SDKs silently read `XXX_API_KEY` / `XXX_BASE_URL` from the environment; the runner must never do that. The conformance suite checks it.
- **No Electron, no persistence.** The adapter gets the key per call and must not store it or log it.
- **Retries.** Probes use `maxRetries: 0` (fast feedback in the form). Runs may keep the SDK default.
- **Stop reasons.** Map them onto `StopReason` (`end_turn`, `max_tokens`, `refusal`, `tool_use`, …), with `other` as the fallback.

## 3. Tests

**Conformance (msw).** Add `packages/runner/test/adapters/xxx.test.ts`. It describes the provider's wire format as a `Wire` and calls `describeAdapterConformance(wire)` from `conformance.ts`. The suite covers:

- deltas in order
- exact usage, and estimated usage when none is reported
- the max-tokens stop
- cancel mid-stream (the request is closed)
- 401/403/429/500/503/404 on run, test and listModels
- a real refused connection
- model parsing
- test latency
- ambient env credentials ignored
- a tool round trip: a streamed tool call reaches `ctx.callTool`, the result goes back in the next request, and usage is summed (the `Wire` describes `toolCallFrames`, `toolNamesIn`, `toolResultIn`)

Add provider-specific tests next to it: the request body mapping, and any odd error shapes (Gemini answers a bad key with 400 `API_KEY_INVALID`, for example).

**Fake server.** Add routes under a new prefix in `src/testing/fakeProviders.ts`, honoring the same prompt controls (`[error:N]`, `[chunks:N]`, `[interval:MS]`, `[tool:NAME {json}]`) and `bad-key`. Add a fixture in `src/testing/fixtures.ts` and include it in `fakeConnections`. The `bin.cjs` integration tests (`test/client.test.ts`) and the desktop e2e (`apps/desktop/e2e/connections.spec.ts`) then run through it. msw cannot reach a spawned process, which is why this real server exists.

**Real provider.** Before calling it done, run it by hand once against the real API: test, list models, and a short streamed run. Record the result in `docs/STATUS.md`.

---

# CLI harnesses

Connections of kind `cli` run a coding-agent CLI as a child process of the runner, one process per turn, behind the same `ProviderAdapter` interface. The base class is `CliHarnessAdapter` (`providers/cli/`). Everything below was verified on 2026-09-19 against **Claude Code 2.1.278** and **codex-cli 0.155.1** by running `--help` and recording real output. The recordings live in `packages/runner/test/fixtures/`. Flags change between versions, so re-verify with `--help` when you bump a harness, and re-record the fixtures.

## Rules every harness follows

- **One process per turn**, started in the working directory: `connection.config.workingDirectory` if set, else `<userData>/workspaces/<conversationId>`. Main resolves it and sends it in `run.start.workingDirectory`, and the runner creates it. The agent's first `readwrite` root goes ahead of both (the runner applies it, Phase 5).
- **Non-interactive, auto-accept.** The harness never waits for a person. The connection form says so.
- **Isolated from the user's CLI setup.** User settings, hooks and MCP servers are not loaded; only the harness's own login is used. `extraArgs` are appended last and can override this.
- **Env hygiene.** The child gets the runner's env minus `ELECTRON_RUN_AS_NODE`, `COMITIVA_*`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY`. The harness then authenticates with the same login its `auth status` reports.
- **Prompt on stdin**, never in argv (no length limits, and nothing shows up in `ps`).
- **History.** Both harnesses keep it (resume by `harnessSessionId`). With a session id, only the new user message is sent. Without one (first turn, or a conversation moved from another connection), the prior messages are replayed as one transcript prompt and a new session starts. If a resume fails because the session no longer exists, and no output has been yielded yet, the turn is retried once as a replay.
- **Cancel** kills the process group (SIGTERM, then SIGKILL after 3 s; `taskkill /T` on Windows). It yields the usage known so far (estimated) and `done(cancelled)`, as the API adapters do.
- **Tools the harness runs itself** are reported as `run.block` `tool_use` / `tool_result` blocks with `toolServerId: 'harness:<provider>'`. They never go through `run.tool_call`, because the harness has already run them.
- **The agent's MCP tools** (Phase 5, ADR 0009, `docs/tools.md`): the only MCP server the harness gets is the runner's proxy, named `comitiva` (`ctx.mcpConfigForCli()` → `TurnSpec.mcp`). Its calls go through the runner's gate and approvals, and the run reports them itself, so a parser must drop the harness's own report of `comitiva` calls. MCP calls can wait for the user: give them a long timeout (30 min). When `mcp.hasFilesystem`, turn the harness's native file tools off, or confine them read-only when they cannot be turned off.
- **testConnection**: locate the binary → `--version` → auth check → (Codex) sandbox probe → a minimal prompt. Errors: `binary_not_found` ("not found at X" / "not found on PATH"), `not_logged_in` (with the login command), `sandbox_unavailable`.

## Claude Code

| Need | Flag / behavior |
|---|---|
| Non-interactive | `-p` (`--print`). With no prompt argument, the prompt is read from stdin. |
| JSON stream | `--output-format stream-json --verbose --include-partial-messages` (the last one gives token deltas). |
| Resume | `--resume <session_id>` keeps the history. `--no-session-persistence` for probes. |
| MCP (Phase 5) | `--mcp-config <file>` plus `--strict-mcp-config`; the file names only the runner's proxy. `MCP_TOOL_TIMEOUT` (ms, env) is set to 30 min, since a call may wait for approval. Claude Code passes its tool-use id in `tools/call` `_meta` (`claudecode/toolUseId`), and the run reuses it. |
| Permissions | `--permission-mode bypassPermissions` (auto-accept; works under `-p`) |
| Built-in tools | `--tools ""` turns all of them off; `--tools A,B` limits the set; `--disallowedTools`. Without tools the defaults stay; with the filesystem server, `--tools WebSearch,WebFetch` (no Read/Write/Edit, and no Bash, which can write too). |
| System prompt | `--append-system-prompt <role>` |
| Model | `--model <id or alias>`; omitted → the harness default |
| Isolation | `--setting-sources ""` and `--strict-mcp-config`. **Not** `--bare`: it skips OAuth and the keychain, so subscription logins stop working. |
| Auth check | `claude auth status` → JSON `{ "loggedIn": true, "authMethod": … }`. Login command: `claude auth login`. |

Output lines (one JSON object each):

| Line | Use |
|---|---|
| `{type:"system", subtype:"init", session_id, tools, mcp_servers, model, permissionMode}` | `run.session` |
| `{type:"stream_event", event:{…}}` | Anthropic SSE events. `content_block_delta` with `text_delta` → `run.text_delta`. `thinking_delta`, `input_json_delta` and the rest are ignored. |
| `{type:"assistant", message:{content:[…]}, error?}` | The complete message. `tool_use` blocks → `run.block`. Its text is used only when that message streamed no deltas. `error: "authentication_failed"` → `not_logged_in`. |
| `{type:"user", message:{content:[{type:"tool_result", tool_use_id, content}]}}` | `run.block` `tool_result` |
| `{type:"result", subtype, is_error, stop_reason, session_id, usage, modelUsage, total_cost_usd, errors?, result?}` | Terminal. `usage` (input, output, cache_read_input_tokens, cache_creation_input_tokens, or `cache_creation`'s 5m/1h buckets summed) → `run.usage`. `modelUsage` is keyed by the model Claude Code really ran and gives its `canonicalModel`; the busiest entry names the turn, which is the only way to know the model when the connection names none. `total_cost_usd` is computed at list prices and is authoritative, so it wins over our table (`costSource: 'harness'`). `output_tokens` already includes `thinkingTokens`. `is_error` → an error from `errors[]` or `result`. |
| `system/status`, `system/thinking_tokens`, `rate_limit_event` | Ignored |

Observed failures:

- Not logged in: exit 1. The `assistant` line has `error: "authentication_failed"` and the text "Not logged in · Please run /login". The `result` has `is_error: true`.
- Unknown resume id: exit 1. `result.subtype: "error_during_execution"`, `errors: ["No conversation found with session ID: …"]`, and the same text on stderr.

## Codex

| Need | Flag / behavior |
|---|---|
| Non-interactive | `codex exec … -` (with `-`, the prompt comes from stdin) |
| JSON stream | `--json` (JSONL events) |
| Resume | `codex exec resume <thread_id> … -` keeps the history. `--ephemeral` for probes. `exec resume` has no `-s`, so the sandbox goes through `-c sandbox_mode="…"` in both cases. |
| MCP (Phase 5) | No file flag: `-c mcp_servers.comitiva.command="…"`, `.args=[…]`, `.env={ ELECTRON_RUN_AS_NODE = "1" }` (TOML values), `.tool_timeout_sec=1800` and `.default_tools_approval_mode="approve"`. Without the last one, `exec` declines every MCP tool that is not `readOnlyHint` on its own ("unavailable without approval"), verified on 0.155.1; the runner is the gate, so Codex lets them through. |
| Approvals | `exec` never prompts (approval policy `never`). Anything that would need approval fails, and the model sees the failure. |
| Sandbox | `sandbox_mode` = `read-only` \| `workspace-write` (default) \| `danger-full-access`, set per connection. On Ubuntu 24.04 with AppArmor's userns restriction, `workspace-write` could not start its bubblewrap sandbox, so even reads in the working directory failed. `codex sandbox -- true` reproduces this in about 1 s (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, exit 1), and testConnection uses it as a probe. |
| Built-in tools | `--disable shell_tool` works, but `apply_patch` (file writes) cannot be turned off (`-c include_apply_patch_tool=false` had no effect). So when the agent has the filesystem server, the runner forces `sandbox_mode="read-only"`: native writes fail, and writes go through the built-in server and its approvals. Without it, **Codex's own file writes never go through Comitiva's approvals**, and the form warns about it. |
| System prompt | `-c developer_instructions="<role>"` (a TOML string) |
| Model | `-m <model>`; omitted → the harness default |
| Isolation | `--ignore-user-config` (auth still comes from `CODEX_HOME`) and `--skip-git-repo-check` (needed outside Git repositories) |
| Auth check | `codex login status` exits 0 ("Logged in using …") or 1 ("Not logged in"). Login command: `codex login`. Check this before the prompt: a run without auth retries 401 about 10 times (~15 s) before failing. |

Output lines:

| Line | Use |
|---|---|
| `{type:"thread.started", thread_id}` | `run.session` |
| `{type:"turn.started"}` | Ignored |
| `{type:"item.completed", item:{type:"agent_message", text}}` | `run.text_delta`, a whole message at a time, `\n\n` between messages. **Codex `exec` has no token deltas**; only the experimental `codex app-server` (JSON-RPC) has them. Revisit when it is stable. |
| `item.started` / `item.completed` with `command_execution {command, aggregated_output, exit_code, status}` | `tool_use` `shell {command}`, then `tool_result` (`isError` when the exit code is non-zero or the status is `failed`) |
| … with `file_change {changes:[{path, kind}], status}` | `tool_use` `apply_patch {changes}`, then `tool_result` |
| … with `mcp_tool_call {server, tool, arguments, result, error, status}` | `tool_use`, then `tool_result` |
| `{type:"error", message}` and `item.type:"error"` | Reconnect notices; logged only |
| `{type:"turn.completed", usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}` | `run.usage`: input = `input_tokens − cached_input_tokens`, cacheRead = cached, output = `output_tokens`. Codex nests breakdowns inside totals (the recordings show 14282 input of which 11008 cached), so `reasoning_output_tokens` is already part of `output_tokens` and is **not** added. Codex names no model. `done(end_turn)`. |
| `{type:"turn.failed", error:{message}}` | Terminal error. `message` is either JSON with `status` (e.g. 400 for an unsupported model → `provider_error`) or text such as "unexpected status 401 Unauthorized: Missing bearer…" (→ `not_logged_in`). |

A cancelled run (SIGTERM) exits 143, having written only `thread.started` and `turn.started`.

## Adding a harness

1. Contract: a config schema (extend `CliConfig`), a `Connection` variant, `cliProviderVariants` in `ipc.ts`, and a `providerDescriptors` entry with `kind: 'cli'`.
2. Runner: `providers/cli/XxxAdapter.ts extends CliHarnessAdapter` (`buildArgs`, `createParser`, `authCheck`, `probeArgs`), and a pure parser in `providers/cli/parsers/` from JSON lines to `AdapterEvent`s. Register it in `createDefaultRegistry()`.
3. Tests: record real output into `test/fixtures/<provider>/` (scrub paths and ids), run parser tests over every fixture, and teach the fake harness (`src/testing/fakeHarness.ts`) to replay them.
4. By hand: `cli.detect`, `connection.test`, a streamed turn, a resumed turn and a cancelled turn with the real binary. Record the results in `docs/STATUS.md`.
