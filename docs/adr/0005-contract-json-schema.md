# 0005 — zod v4 in the contract, JSON Schema via `z.toJSONSchema`

- Status: Accepted
- Date: 2026-09-18

## Context

The TypeScript side (desktop, runner) and the PHP hub share entity, block and protocol shapes (SPEC principle 6). design.md suggested `zod-to-json-schema`, which targets zod 3 and is not maintained for zod 4.

## Decision

- `@comitiva/contract` uses **zod 4**. Its native `z.toJSONSchema` generates **draft 2020-12** documents, one file per published schema, into `packages/contract/schema/*.json`, each with a stable `$id` (`https://comitiva.dev/schema/<Name>.json`).
- `pnpm contract:schema` regenerates them; the files are committed. A unit test and a CI step fail if the committed files drift from the zod source.
- The package is ESM, with `sideEffects: false` and a zod-free `@comitiva/contract/ipc-channels` subpath for the sandboxed preload.

## Consequences

- The hub validates payloads with any draft 2020-12 validator (e.g. `opis/json-schema`).
- Schemas are generated from the `input` side of zod (defaults are optional), which is what external producers must send.
- `z.unknown()` fields (tool inputs, results) become unconstrained in JSON Schema.
