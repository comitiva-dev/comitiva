# 0007 — How CLI harnesses run

- Status: Accepted
- Date: 2026-09-19

## Context

Phase 2 adds connections of kind `cli`: Claude Code and Codex run as child processes of the runner, behind the same `ProviderAdapter` interface as the API providers (SPEC §4.2). The choices below affect the contract (config, protocol), the runner, main and the connection form. They were settled after checking both CLIs' `--help` and recording their real output (Claude Code 2.1.278, codex-cli 0.155.1; `docs/providers.md` → CLI harnesses).

## Decision

1. **One process per turn.** Claude Code runs `-p --output-format stream-json --verbose --include-partial-messages`; Codex runs `exec --json`. The prompt goes on stdin. The harness keeps the history: turns resume by `harnessSessionId` (`--resume` / `exec resume`). Without a session id, or when the harness has lost the session, the history is replayed as a transcript into a new session.
2. **Non-interactive, auto-accept.** Claude Code runs with `--permission-mode bypassPermissions`. Codex `exec` never prompts: its approval policy is `never`, and a per-connection sandbox (`workspace-write` by default, `read-only`, or `danger-full-access`) bounds it. The connection form says this in plain words.
3. **Isolated from the user's CLI setup.** Claude Code gets `--setting-sources "" --strict-mcp-config`; Codex gets `--ignore-user-config --skip-git-repo-check`. Only the harness's own login is used. `extraArgs` are appended last, so a user can override any of these on purpose.
4. **Env hygiene.** The child env drops `ELECTRON_RUN_AS_NODE`, `COMITIVA_*` and provider key variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`), so the harness authenticates as its `auth status` says. This keeps Phase 1's rule of no ambient credentials.
5. **Codex streams one message at a time.** `exec --json` has no token deltas: each `agent_message` becomes one `run.text_delta`. The experimental `codex app-server` (JSON-RPC) has deltas, and gets revisited once it is stable.
6. **Working directory.** The connection's `workingDirectory`, else `<userData>/workspaces/<conversationId>`. Main resolves it and sends it as `run.start.workingDirectory`; the runner creates it. From Phase 5, the agent's first `readwrite` root goes ahead of both.
7. **Tools the harness runs itself** are reported as `run.block` `tool_use` / `tool_result` blocks with `toolServerId: 'harness:<provider>'`. They never go through `run.tool_call`, because the harness has already run them.

## Consequences

- Everything a harness does in its working directory happens without per-action approval. The form warns about this, and Phase 5 routes file writes through the built-in `filesystem` server where possible. Claude Code's native file tools can then be turned off (`--tools`). Codex's `apply_patch` cannot (verified), so its form always carries a warning.
- On systems where Codex's bubblewrap sandbox cannot start (Ubuntu 24.04 with AppArmor's userns restriction), testConnection fails with `sandbox_unavailable`, detected cheaply with `codex sandbox -- true`. The user then chooses `danger-full-access` knowingly.
- Cancel kills the whole process group (POSIX) or tree (`taskkill /T` on Windows), then ends the run with estimated usage and `done(cancelled)`. Windows spawning of `.cmd` shims is implemented but not yet verified on Windows.
- Harness flags change between versions. Adapters are pinned to verified flags, fixtures are real recordings, and `docs/providers.md` says how to re-verify on a version bump.
