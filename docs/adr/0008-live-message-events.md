# 0008 — Live message events and per-conversation revisions

- Status: Accepted
- Date: 2026-09-21

## Context

Phase 4 streams replies from main to the renderer while also serving pages of stored messages (`messages.list`). A client opens a conversation at any moment, including in the middle of a reply, and several conversations stream at the same time. A page and the event stream have to line up. Without an ordering, a page fetched mid-stream could miss a delta that was already sent, or apply one twice. A snapshot emitted before the page was served, but delivered after it, could also overwrite newer content. The same problem comes back in Phase 8, when `RemoteBackend` gets events over WebSocket from the hub, so the rule belongs in the contract and not only in the desktop.

## Decision

1. **Three message events.**
   - `message.updated { message, rev }` is a full snapshot. It is sent when a message is created, when a reply is reset for retry, and when a reply reaches its final state.
   - `message.delta { conversationId, messageId, rev, text }` carries streamed text.
   - `message.block { conversationId, messageId, rev, block }` carries a complete block (image, tool use or result).
   - `conversation.updated { conversation }` carries status, title and activity. It has no `rev`, because the entity is always sent whole.
2. **One revision counter per conversation**, not per reply. Every message event raises it by exactly one. A retry, the second message and the final snapshot all move the same counter, so a client can always tell whether it missed something.
3. **Pages carry the revision they reflect.** `messages.list` returns `{ messages, hasMore, rev }`. For a conversation that is streaming, main first flushes the text it has not sent yet, then returns the reply with its live content. The page is then exactly the state at `rev`.
4. **Client rule**, the same for every shell:
   - An event with `rev <= state.rev` is already included, so it is dropped.
   - `rev === state.rev + 1` is applied.
   - A larger gap, or a delta for an unknown message, means something was missed. The client reloads the page.
   - Events that arrive while the first page loads are buffered, then replayed against the page's `rev`.
   - Deltas are applied with the contract's `appendText`: extend the last text block, else start a new one. Streamed state and stored state therefore agree.
5. **Batching is main's concern.** Deltas are coalesced to at most one event per frame (16 ms) per conversation. SQLite gets a checkpoint about every 250 ms. The final state, the usage record and the conversation status are written in one transaction on the run's terminal event.
6. **Revisions live in memory in main.** They start at 0 when the app starts. That is enough, because a restarted app also restarts its renderer, which loads pages again. Replies that were streaming when the app stopped end at boot as `error { code: 'interrupted' }` and can be retried.

## Consequences

- The renderer's messages store (`store/messages.ts`) implements rule 4 and is unit-tested against gaps, stale snapshots and buffering. Only the streaming message object changes identity, so other rows do not re-render.
- A missed event costs one page reload, never a wrong transcript.
- The hub (Phase 8) must keep a per-conversation revision and return it with pages. With several hub instances, that counter has to be shared (for example, a column on the conversation) rather than held in memory.
- Unread counts come from final `message.updated` events for replies whose conversation is not on screen. They are persisted as `conversations.last_read_seq`.
