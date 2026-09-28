# 0017 — Sync model: the hub is the source of truth, desktops execute and publish

- Status: Accepted
- Date: 2026-09-28

## Context

Phase 8 adds an optional hub (ADR 0015) so a team can share agents and
conversations in real time. Its exit criterion is "two desktops see the same
conversation live". The hub does not call LLMs in this phase (that is
Phase 9). The questions:

- Who owns a shared conversation's state, and what happens when a desktop is
  offline?
- Who runs a shared agent, when connections, keys, folders and stdio tool
  servers exist only on one machine?
- How does a reply streaming on one desktop reach the others, with the
  ordering guarantees the UI already relies on (ADR 0008)?
- Where do the hub credentials live on the desktop?

## Decision

**Two scopes, no merge.** *Personal* is today's local-first desktop:
SQLite, offline, unchanged. A *workspace* lives on the hub, which is its
source of truth. The desktop keeps no copy of workspace data to edit offline.
Every workspace write is a hub request, and a failed request is a visible
error (`hub_unreachable`). There is no offline queue and no merge in this
phase. The UI shows one scope at a time (the workspace switcher). Sharing
an agent **copies** it into a workspace, and the local agent and its
conversations stay Personal.

**What stays on each desktop.** Connections and their keys, an agent's
folders, stdio and built-in tool servers, harness sessions, allow-always
decisions, and the secret header values of workspace tool servers. A shared
agent names a provider and a model, never a connection. Each member *links*
it once to one of their own connections, and may add folders and local tool
servers (`AgentLink`, kept in the desktop's SQLite). Workspace tool servers
are `http` only. A secret header is stored on the hub as
`{ secretRef: 'member' }` and its value in each member's SecretStore.

**Desktops execute, the hub records and fans out.** Whoever sends a message
runs the turn on their desktop with their linked connection. The desktop's
`ConversationService` runs exactly as for Personal conversations, but through
a hub `ChatStore` instead of SQLite:

1. `POST /conversations/{id}/runs` takes the conversation's **run lock**, one
   active run per conversation across all desktops (409
   `conversation_busy`). It writes the user message and an empty streaming
   reply in one transaction and returns the history the runner needs.
2. Runner events are published in batches (`POST /runs/{id}/events`, every
   100 ms): text deltas, blocks, tool calls and tool results, in their
   `RunnerEvent` shape. Each batch has a number, so a retried batch is
   ignored rather than applied twice. The hub applies each event to the
   stored reply, gives it the conversation's next `rev`, and broadcasts it
   on `private-conversation.{id}`, with RunnerEvent names (`run.text_delta`,
   `run.block`, …).
3. `POST /runs/{id}/finish` writes the final content (authoritative over the
   streamed events), the status, and the usage record with its cost frozen
   by the desktop (ADR 0011), all in one transaction.

A run holds a **lease** of 30 seconds, renewed by every batch and by a
heartbeat every 10 seconds. If the desktop quits, crashes or loses the hub,
the lease lapses and the hub ends the reply as `error { interrupted }`,
which anyone can retry. A late `finish` gets `run_expired`, and the desktop
cancels its runner.

**Every member sees the same stream, the executing one included.** In a
workspace, the renderer gets message events only from the hub's broadcasts,
never from its own main process. That gives one ordering (the hub's `rev`)
for everyone and the same page-then-stream reconciliation as ADR 0008. It
costs the executing member about one batch interval of extra latency.

**Approvals belong to the executing member.** A tool call that needs
approval acts on the executing desktop's machine and folders. Only that
member can answer it. The others see the pending call and whose desktop is
waiting. Any member with the right role can ask a run to stop:
`run.cancel_requested` reaches the executing desktop, which cancels.

**Credentials stay in main.** The desktop signs in with email and password
and gets a personal access token for the device (Sanctum). Main keeps it in
the SecretStore (`hub:token`) and holds both the REST client and the
WebSocket. The renderer's `RemoteBackend` reaches the hub through a
`HubTransport`: over IPC on the desktop (main adds the token), and in
Phase 9 over fetch with a session cookie in the browser. The rule that no
secret reaches the renderer (architecture.md) holds.

## Consequences

- Workspaces need the hub to be reachable. An outage makes a workspace
  read-only-with-errors, and Personal keeps working. Offline edits and merge
  are future work, with their own ADR.
- A member without a matching connection cannot send to a shared agent until
  they link one (`agent_not_linked`). Nobody's key is ever shared.
- The hub stores message content and usage, but never keys, folders or the
  secret values of tool servers.
- The run lock and the lease are the only cross-desktop coordination. Two
  desktops cannot run the same conversation at once, and a dead desktop
  blocks a conversation for at most one lease.
- Streaming to the hub costs one HTTP request per 100 ms per active run. That
  is fine for teams. A WebSocket upload path can replace it later, keeping
  the same event shapes.
- The hub's run events mirror `RunnerEvent`, so the same contract types
  describe what a runner emits, what a desktop publishes, and what members
  receive.
