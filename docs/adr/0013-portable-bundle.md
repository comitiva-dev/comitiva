# 0013 — A portable bundle for agents, connections and tool servers

- Status: Accepted
- Date: 2026-09-23

## Context

Phase 7 exports and imports agents, connections and tool servers as JSON. The
format outlives this release: the Phase 8 hub will import what a desktop
exported (a team's shared agents) and export what a desktop imports. Three
things had to be settled for both sides.

**Secrets.** A connection's key and a tool server's secret env or header
values live in the OS keychain (safeStorage), and only refs travel. A file the
user mails to a colleague must carry neither values nor refs: a ref from one
machine means nothing on another, and a value in a JSON file is a leak.

**Identity.** Ids are ULIDs local to one database. Importing the same file
twice, or into a database that already has objects with those ids, must not
collide or overwrite.

**Machine-specific settings.** Roots (folders), a CLI harness's binary path
and working directory belong to one computer.

## Decision

**The format is a zod schema in `@comitiva/contract` (`portable.ts`),
published as `schema/PortableBundle.json`.** `format: "comitiva.bundle"`,
`version: 1`, `exportedAt`, `app`, and three arrays. A reader refuses another
format or version with `invalid_request` instead of guessing.

**No secret and no secret ref, ever.** A connection records `hadKey: true`; a
secret env or header value is `{ "secret": true }`. The schema has no field
that could hold either, so a bundle with a `secretRef` does not parse.

**Objects point at each other by `ref`, local to the file.** An agent names
its connection's ref and its tool servers' refs; built-in servers are named
by their fixed ids (`filesystem`, `google-drive`) and are not in the file.
Import creates new objects with new ids every time and remaps the refs.

**Import finishes what it can and says what it could not.** It runs in one
transaction and fails whole on a malformed file. Otherwise it returns an
`ImportReport`: counts, plus warnings by code — `key_needed`, `secret_needed`
(an env or header name), `root_missing`, `binary_not_found`, and
`agent_skipped` (an agent this database cannot hold, with the error code,
such as a disabled connection). An imported server's secret values point at
refs with nothing stored, which the existing path already turns into
`secret_missing` when it starts.

Conversations are not in the bundle; one is exported as Markdown, for people
to read.

## Consequences

- The hub implements the same schema (PHP, from the JSON Schema) and the same
  remapping; a bundle moves between them unchanged.
- Machine-specific values travel as they are and are flagged, not dropped: a
  team on similar machines gets them right, and anyone else is told.
- Importing twice creates duplicates. Merging by name was rejected: two
  agents may share a name, and a silent merge could change an agent the user
  is using.
