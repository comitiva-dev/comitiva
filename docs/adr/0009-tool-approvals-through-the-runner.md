# 0009 — Tool approvals go through the runner, for API and CLI runs alike

- Status: Accepted
- Date: 2026-09-21

## Context

Phase 5 lets agents use MCP servers, starting with the built-in `filesystem` server. SPEC §2.5: reading inside the roots is free, writing asks for approval, outside the roots is denied. Two kinds of runs must follow that:

- **API runs** (Anthropic, OpenAI-compatible, Gemini, Ollama): the runner drives the tool loop, so it sees every call before it happens.
- **CLI harness runs** (Claude Code, Codex): the harness drives its own loop and calls MCP servers itself, with auto-accept (ADR 0007).

The Phase 0 sketch had the harness spawn the filesystem server directly, with the server asking the runner for approval over an `--approval-socket`. That leaves third-party servers ungated under harnesses, puts their env secrets in a temp config file, starts a new server per turn, and splits approvals in two code paths.

## Decision

1. **The runner is the only MCP client of every server.** `McpClientManager` keeps one client per server launch (stdio or Streamable HTTP), started on demand, reused across runs and restarted on its next use after a crash. The built-in filesystem server gets the agent's roots as `--root <path>:<mode>` arguments, so instances are keyed by server and roots.
2. **One gate.** Every call goes through `Run.callTool`: `PermissionGate` decides `allow` (read-only by `readOnlyHint`, a recorded allow-always, or the `allow-writes` policy), `deny` (non-read-only tools under the `read-only` policy, which also hides them from the model) or `ask`. For `ask`, the runner emits `run.tool_call { requiresApproval: true }` and waits for `run.approval`; nothing reaches the server before the answer. Tools without annotations ask.
3. **CLI harnesses get a proxy, not the servers.** For each turn with tools, the runner writes an MCP config whose only server is `comitiva`: `mcp-proxy.cjs`, bundled next to the runner, launched by the harness with a path to a 0600 file holding a local socket and a per-run token. The proxy connects back to the runner's `ToolBridge` (a Unix socket in a 0700 temp dir; a named pipe on Windows), proves the token, and forwards `tools/list` and `tools/call` to the run. The run reports those calls itself (tool_use block, tool_call, tool_result), so the harness parsers drop their own copy (`mcp__comitiva__*` in Claude Code, `mcp_tool_call` items with `server: comitiva` in Codex).
4. **The filesystem server trusts its client for approvals, not for paths.** It never asks. It only registers write tools when started with `--gated-by-client` (the runner always passes it), and `RootGuard` refuses anything outside the roots on every call, including symlink escapes.
5. **Native file tools.** When the agent has the filesystem server, Claude Code runs with `--tools WebSearch,WebFetch` (no Read, Write, Edit or Bash), and Codex runs with `sandbox_mode=read-only` because `apply_patch` cannot be turned off. Codex also gets `mcp_servers.comitiva.default_tools_approval_mode="approve"`: its `exec` mode would otherwise decline non-read-only MCP tools on its own, and the runner is already the gate. Both harnesses get a 30-minute MCP call timeout, since a call can wait for the user.

## Consequences

- API and CLI runs share the gate, the approval card, the allow-always records and the audit trail. Third-party servers are gated under harnesses too.
- Server secrets stay in the runner's memory: the temp config holds only the proxy command and a path to the token file. Both files are removed when the turn ends.
- The runner must outlive the harness turn. It does: a runner crash already ends its runs with `runner_crashed`, and the proxy exits when the socket closes.
- The harness sees the tools as `mcp__comitiva__<server>__<tool>` (for example `mcp__comitiva__fs__write_file`), not under their own server names.
- Verified with the real Claude Code 2.1.278 (it passes its tool-use id in `_meta`, so block ids match the harness's) and Codex 0.155.1 (read, write after approval, file created).
- This deviates from the Phase 0 sketch in SPEC §4.2/§4.3 and design §5; both are updated.
