# 0003 — Drizzle ORM with generated SQL migrations

- Status: Accepted
- Date: 2026-09-18

## Context

The desktop stores everything except secrets in SQLite via better-sqlite3 (SPEC §4). SPEC §7 asked for a choice between drizzle and kysely. design.md §3.2 sketched a hand-written `0001_init.sql` tracked in a `schema_migrations` table.

## Decision

Use **Drizzle** (`drizzle-orm/better-sqlite3`):

- The schema lives in TypeScript at `apps/desktop/src/main/db/schema.ts`.
- `pnpm --filter desktop db:generate` (drizzle-kit) generates SQL migrations into `src/main/db/migrations/` (`0000_init.sql` + `meta/`). They are committed and reviewed like code.
- `Database.migrate(folder)` applies them with Drizzle's migrator, which tracks them in `__drizzle_migrations` (this replaces `schema_migrations`).
- Migrations ship with the packaged app as `extraResources/migrations`.

## Consequences

- Table types come from the schema, so repositories get typed rows without hand-written interfaces.
- Migrations are still plain SQL files. The Laravel hub can read them as a reference, though it keeps its own Postgres migrations.
- Hand edits to generated migrations are discouraged. Custom SQL goes in a separate `drizzle-kit generate --custom` migration.
- better-sqlite3 13 is built on N-API, so one compiled binary works under Node (tests) and Electron (app). No `electron-rebuild` step is needed; electron-builder still rebuilds or fetches it when packaging.
