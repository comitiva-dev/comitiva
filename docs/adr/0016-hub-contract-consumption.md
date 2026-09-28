# 0016 — How the hub consumes the contract: a build-time copy at a contract tag

- Status: Accepted
- Date: 2026-09-28

## Context

ADR 0015 keeps `@comitiva/contract` here as the single source of truth for
the hub's HTTP and WebSocket payloads, and says the hub pins a release of it.
Phase 8 needs the mechanics:

- Which release? App releases (`v*`) come months apart and build installers;
  the hub needs contract changes on its own rhythm.
- How do the files reach the hub? Two candidates: a **build-time copy** of
  `packages/contract/schema/*.json` into the hub's tree, or a **Composer path
  repository** that points at a checkout of this repository.
- How does the hub know it has the files it thinks it has?

## Decision

**Contract tags.** A contract release is a tag `contract-vX.Y.Z` in this
repository, with `packages/contract/package.json` at the same version. The
tag does not match `release.yml`'s `v*` trigger, so it builds nothing. Semver
applies to the JSON Schemas:

- a new optional field or a new schema is a minor version;
- anything an existing hub or desktop would reject or misread is a major
  version, together with a new `HUB_API_VERSION`.

The hub's API version (`/api/v1`, `HubMeta.apiVersion`) moves only with
breaking changes.

**A build-time copy, read from the tag.** The hub runs
`php artisan contract:sync <tag>`. It copies every `schema/*.json` into
`resources/contract/schema/` and writes `resources/contract/VERSION`, which
holds the tag and each file's SHA-256. The hub commits both.

- The files are read with `git show <tag>:packages/contract/schema/<file>`
  from a clone (`--from=<path>` for a local sibling checkout, or a fresh
  clone of the GitHub repository). They come from the tag, never from a
  working tree, so an uncommitted change cannot leak into the hub.
- `php artisan contract:check` (in the hub's CI) fetches the pinned tag
  again and fails on any difference: a file edited by hand, a file missing,
  or a tag that moved.
- The hub loads schemas by their `$id` (`https://comitiva.dev/schema/<Name>.json`)
  and validates with a draft 2020-12 validator (`opis/json-schema`), as
  ADR 0005 expects. Request bodies are validated on the way in. Responses and
  broadcast payloads are validated in the hub's tests.

**Not chosen: a Composer path repository.** It needs a sibling checkout of
this repository wherever the hub is built: in its CI, in its Docker build,
and for everyone who self-hosts from source. It would also pin a path
instead of a version, which is what the copy exists to do. Publishing
the schemas as a Composer package from this Apache repository would add a
second release channel for no gain over a tag.

## Consequences

- A contract change that the hub needs takes three steps: change and tag
  here, `contract:sync` in the hub, commit. The drift check makes a skipped
  or partial step fail CI.
- The hub's tree carries a readable copy of the contract it implements, so
  an AGPL hub built from source needs nothing from this repository.
- zod refinements (`UserContent` must not be blank, for example) do not
  survive the conversion to JSON Schema. The hub repeats those few checks
  in PHP, and its tests name each one.
- Until this repository is public, the hub's CI needs a read token to fetch
  the tag. Locally, `--from=../comitiva` reads the sibling clone.
