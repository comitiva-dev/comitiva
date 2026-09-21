# Architecture Decision Records

One file per decision that affects more than one package. Format: context, decision, consequences. Superseded ADRs stay, marked as such.

| # | Decision | Status |
|---|---|---|
| [0001](0001-name-and-license.md) | Name "Comitiva", license Apache-2.0 | Accepted |
| [0002](0002-runner-execution.md) | Run the runner as Electron in Node mode (`ELECTRON_RUN_AS_NODE`) | Accepted |
| [0003](0003-desktop-orm.md) | Drizzle ORM with generated SQL migrations on better-sqlite3 | Accepted |
| [0004](0004-canonical-blocks.md) | Anthropic Messages format as the canonical block format | Accepted |
| [0005](0005-contract-json-schema.md) | zod v4 in `contract`, JSON Schema via `z.toJSONSchema` | Accepted |
| [0006](0006-toolchain-pins.md) | Toolchain pins: pnpm 10, TypeScript 6.0, Vite 7, Node 24 | Accepted |
| [0007](0007-cli-harness-execution.md) | CLI harnesses: one process per turn, auto-accept, isolated, harness-kept history | Accepted |
| [0008](0008-live-message-events.md) | Live message events: snapshots plus deltas, one revision counter per conversation | Accepted |

Still open (see `docs/STATUS.md`): implementation of the `google-drive` MCP server (own vs community), decided in Phase 5b.
