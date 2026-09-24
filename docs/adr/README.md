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
| [0009](0009-tool-approvals-through-the-runner.md) | Tool approvals go through the runner; CLI harnesses reach tools through its MCP proxy | Accepted |
| [0010](0010-google-drive-server-and-oauth.md) | Our own Google Drive server; OAuth and refresh in the desktop, the token handed over per launch | Accepted |
| [0011](0011-pricing-and-cost-at-write-time.md) | Prices ship with the runner as one versioned JSON; cost is computed at write time and a correction recosts | Accepted |
| [0012](0012-attachments-as-stored-file-blocks.md) | Attachments are stored file blocks, resolved to base64 by the shell before a run; providers without images get a note | Accepted |
| [0013](0013-portable-bundle.md) | Agents, connections and tool servers travel as a versioned portable bundle in the contract, with no secrets and file-local refs | Accepted |
| [0014](0014-packaging-and-updates.md) | electron-builder for dmg, nsis, AppImage, deb and rpm; signing from secrets when present; updates from GitHub Releases | Accepted |
| [0015](0015-hub-repositories-and-editions.md) | The hub in its own repository: AGPL community edition, private enterprise package for the hosted hub; contract and web UI stay here | Accepted |
