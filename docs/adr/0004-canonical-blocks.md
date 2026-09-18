# 0004 — Anthropic Messages format as the canonical block format

- Status: Accepted
- Date: 2026-09-18

## Context

Messages flow between the renderer, main, SQLite, the runner, the hub, and many providers (Anthropic, OpenAI-compatible, Gemini, Ollama, CLI harnesses). We need one content representation for storage and the protocol.

## Decision

`Block` in `@comitiva/contract` follows the Anthropic Messages API shapes: `text`, `image`, `document`, `tool_use`, `tool_result`. It uses camelCase fields and a `source` union of `{ kind: 'base64' }` and `{ kind: 'file', path }`. `tool_use` carries `toolServerId` so the runner can route calls. `tool_result.content` accepts only `text`, `image` and `document`, the same restriction as the Anthropic API.

Message roles are `user`, `assistant` and `tool`. A `tool` message carries `tool_result` blocks, and adapters map it to the provider's format (Anthropic: a `user` turn; OpenAI: `role: tool`; Gemini: `functionResponse`).

## Consequences

- The Anthropic adapter is a near 1:1 mapping. Other adapters translate in both directions.
- `file` sources are resolved by the shell or adapter. The Anthropic adapter rejects them with `unsupported_content` until attachments land (Phase 7).
- The hub stores the same JSON, validated with the generated JSON Schema (ADR 0005).
