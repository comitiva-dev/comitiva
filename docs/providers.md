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
  capabilities: textOnly,             // be honest: only what the adapter does today
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
      body: async function* (): AsyncGenerator<AdapterEvent, StopReason> {
        // call the API with `signal`, yield { type: 'run.text_delta', text },
        // usage.report({ input, output, cacheRead, final: true }) when the provider says so,
        // return the mapped stop reason
      },
    });
  }
}
```

Register it in `createDefaultRegistry()` (`providers/ProviderRegistry.ts`).

The helpers in `providers/api/shared.ts` enforce the rules every adapter must follow:

| Rule | Helper |
|---|---|
| Every turn ends with exactly one `run.usage`, then `run.done`. Failures are thrown as `AppError`, and `Run` turns them into `run.error`. | `streamTurn` |
| Cancel is not an error. It yields the usage known so far (`estimated: true`) and `done { stopReason: 'cancelled' }` right away, even if the SDK keeps its stream open. | `streamTurn` (races every read against the signal) |
| Usage the provider does not report is estimated: about 4 chars per token for output, and the prompt for input. | `UsageTracker` |
| HTTP errors map to stable codes: 401/403 → `auth_failed`; 429 → `rate_limited` (retryable); 5xx → `provider_unavailable` (retryable); other 4xx → `provider_error`. | `httpError` |
| No response (refused, DNS, reset) → `provider_unavailable` (retryable). A timeout → `timeout` (retryable). | `networkError`, `isFetchFailure` |
| Test and list models give up after 15 s with `timeout`. `testConnection` never throws; it returns `{ ok: false, error }`. | `withDeadline`, `probe` |
| Messages the provider cannot take yet (images, tool results) fail with `unsupported_content`. | `plainText` |

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

Add provider-specific tests next to it: the request body mapping, and any odd error shapes (Gemini answers a bad key with 400 `API_KEY_INVALID`, for example).

**Fake server.** Add routes under a new prefix in `src/testing/fakeProviders.ts`, honoring the same prompt controls (`[error:N]`, `[chunks:N]`, `[interval:MS]`) and `bad-key`. Add a fixture in `src/testing/fixtures.ts` and include it in `fakeConnections`. The `bin.cjs` integration tests (`test/client.test.ts`) and the desktop e2e (`apps/desktop/e2e/connections.spec.ts`) then run through it. msw cannot reach a spawned process, which is why this real server exists.

**Real provider.** Before calling it done, run it by hand once against the real API: test, list models, and a short streamed run. Record the result in `docs/STATUS.md`.

---

# CLI harnesses

Connections of kind `cli` run a coding-agent CLI as a child process of the runner, one process per turn, behind the same `ProviderAdapter` interface. The base class is `CliHarnessAdapter` (`providers/cli/`). Everything below was verified on 2026-09-19 against **Claude Code 2.1.278** and **codex-cli 0.155.1** by running `--help` and recording real output. The recordings live in `packages/runner/test/fixtures/`. Flags change between versions, so re-verify with `--help` when you bump a harness, and re-record the fixtures.

## Rules every harness follows

- **One process per turn**, started in the working directory: `connection.config.workingDirectory` if set, else `<userData>/workspaces/<conversationId>`. Main resolves it and sends it in `run.start.workingDirectory`, and the runner creates it. In Phase 5, the agent's first `readwrite` root goes ahead of both.
- **Non-interactive, auto-accept.** The harness never waits for a person. The connection form says so.
- **Isolated from the user's CLI setup.** User settings, hooks and MCP servers are not loaded; only the harness's own login is used. `extraArgs` are appended last and can override this.
- **Env hygiene.** The child gets the runner's env minus `ELECTRON_RUN_AS_NODE`, `COMITIVA_*`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY`. The harness then authenticates with the same login its `auth status` reports.
- **Prompt on stdin**, never in argv (no length limits, and nothing shows up in `ps`).
- **History.** Both harnesses keep it (resume by `harnessSessionId`). With a session id, only the new user message is sent. Without one (first turn, or a conversation moved from another connection), the prior messages are replayed as one transcript prompt and a new session starts. If a resume fails because the session no longer exists, and no output has been yielded yet, the turn is retried once as a replay.
- **Cancel** kills the process group (SIGTERM, then SIGKILL after 3 s; `taskkill /T` on Windows). It yields the usage known so far (estimated) and `done(cancelled)`, as the API adapters do.
- **Tools the harness runs itself** are reported as `run.block` `tool_use` / `tool_result` blocks with `toolServerId: 'harness:<provider>'`. They never go through `run.tool_call`, because the harness has already run them.
- **testConnection**: locate the binary → `--version` → auth check → (Codex) sandbox probe → a minimal prompt. Errors: `binary_not_found` ("not found at X" / "not found on PATH"), `not_logged_in` (with the login command), `sandbox_unavailable`.

## Claude Code

| Need | Flag / behavior |
|---|---|
| Non-interactive | `-p` (`--print`). With no prompt argument, the prompt is read from stdin. |
| JSON stream | `--output-format stream-json --verbose --include-partial-messages` (the last one gives token deltas). |
| Resume | `--resume <session_id>` keeps the history. `--no-session-persistence` for probes. |
| MCP (Phase 5) | `--mcp-config <file>` plus `--strict-mcp-config` |
| Permissions | `--permission-mode bypassPermissions` (auto-accept; works under `-p`) |
| Built-in tools | `--tools ""` turns all of them off; `--tools A,B` limits the set; `--disallowedTools`. Phase 2 keeps the defaults. Phase 5 removes the file-writing ones. |
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
| `{type:"result", subtype, is_error, stop_reason, session_id, usage, errors?, result?}` | Terminal. `usage` (input, output, cache_read_input_tokens, cache_creation_input_tokens) → `run.usage`. `is_error` → an error from `errors[]` or `result`. |
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
| MCP (Phase 5) | No file flag: `-c mcp_servers.<name>.command="…"` and `-c mcp_servers.<name>.args=[…]` (TOML values), or a temp `CODEX_HOME`. Decided in Phase 5. |
| Approvals | `exec` never prompts (approval policy `never`). Anything that would need approval fails, and the model sees the failure. |
| Sandbox | `sandbox_mode` = `read-only` \| `workspace-write` (default) \| `danger-full-access`, set per connection. On Ubuntu 24.04 with AppArmor's userns restriction, `workspace-write` could not start its bubblewrap sandbox, so even reads in the working directory failed. `codex sandbox -- true` reproduces this in about 1 s (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, exit 1), and testConnection uses it as a probe. |
| Built-in tools | `--disable shell_tool` works, but `apply_patch` (file writes) cannot be turned off (`-c include_apply_patch_tool=false` had no effect). **Codex's own file writes never go through Comitiva's approvals**, and the form warns about it. |
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
| `{type:"turn.completed", usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}` | `run.usage`: input = `input_tokens − cached_input_tokens`, cacheRead = cached, output = `output_tokens`. `done(end_turn)`. |
| `{type:"turn.failed", error:{message}}` | Terminal error. `message` is either JSON with `status` (e.g. 400 for an unsupported model → `provider_error`) or text such as "unexpected status 401 Unauthorized: Missing bearer…" (→ `not_logged_in`). |

A cancelled run (SIGTERM) exits 143, having written only `thread.started` and `turn.started`.

## Adding a harness

1. Contract: a config schema (extend `CliConfig`), a `Connection` variant, `cliProviderVariants` in `ipc.ts`, and a `providerDescriptors` entry with `kind: 'cli'`.
2. Runner: `providers/cli/XxxAdapter.ts extends CliHarnessAdapter` (`buildArgs`, `createParser`, `authCheck`, `probeArgs`), and a pure parser in `providers/cli/parsers/` from JSON lines to `AdapterEvent`s. Register it in `createDefaultRegistry()`.
3. Tests: record real output into `test/fixtures/<provider>/` (scrub paths and ids), run parser tests over every fixture, and teach the fake harness (`src/testing/fakeHarness.ts`) to replay them.
4. By hand: `cli.detect`, `connection.test`, a streamed turn, a resumed turn and a cancelled turn with the real binary. Record the results in `docs/STATUS.md`.
