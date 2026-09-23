# 0012 — Attachments are stored file blocks, resolved by the shell before a run

- Status: Accepted
- Date: 2026-09-23

## Context

Phase 7 adds attachments to the composer: images and text files. The canonical
blocks (ADR 0004) already had `image` and `document` with a `base64` or a
`file` source, but nothing produced or read a `file` source, and only the
Anthropic adapter sent images. Three questions cross packages.

**Where the bytes live.** Base64 inline in `messages.content` would put
megabytes into a JSON column that every page load parses, every stream
checkpoint rewrites, and the Phase 8 hub would sync. A file on disk keeps the
row small, but somebody has to read it.

**Who reads the file.** The runner is stateless about persistence and could be
another process on another machine (the hub runs API connections, Phase 9). A
path the runner opens on its own is a path it can be tricked into opening.

**What a provider without images gets.** CLI harnesses take a text prompt; a
local model may be text-only. Failing the whole turn with `unsupported_content`
because a screenshot was attached is the wrong answer.

## Decision

**Files live in the shell's attachment store, and a block points to one by
name.** The desktop keeps them in `<userData>/attachments/<ULID><ext>` (0600,
directory 0700), written atomically. A `file` source's `path` is that name,
relative to the store, never an absolute path; it gains an optional
`mediaType`, and an `image` block an optional `name`. Main checks every file
before storing it: images are sniffed from their first bytes (PNG, JPEG, GIF,
WebP; the declared type is not trusted) and capped at 5 MB, text must be valid
UTF-8 without NUL and is capped at 1 MB, and a message takes ten.

**The shell resolves file sources to base64 before `run.start`.** The runner
never reads a `file` source: one that reaches it is `invalid_request`. The
desktop reads through a small cache (files never change once stored). A file
that is gone becomes a text note, so the turn still runs.

**Adapters degrade instead of failing.** `providers/media.ts` is the one place
that decides:

- text documents become text for every provider, a `<document name="…">`
  element around the file (Anthropic gets a plain-text `document` block);
- images go natively to the four API providers (Anthropic `image`,
  OpenAI-compatible `image_url` data URL, Gemini `inlineData`, Ollama
  `images`); where a provider does not take them (CLI harnesses) they become
  `[Image "x.png" attached but not sent: … does not accept images]`;
- another binary document (a PDF to anything but Anthropic) becomes a note too.

The composer tells the user before sending when the agent's connection cannot
see images.

**The renderer loads stored images through the backend.** `Backend.attachments.url`
returns `comitiva-attachment://file/<name>` in the desktop: a privileged scheme
whose handler serves only names that match the ULID pattern and resolve, after
realpath, inside the store. The CSP allows that scheme for images and nothing
else. A `RemoteBackend` (Phase 8) returns an HTTP URL instead.

## Consequences

- Rows stay small and the hub can sync attachments as files, separately.
- The runner's contract did not change shape: it still receives base64.
- A model that is sent an image it cannot handle (a text-only model behind an
  OpenAI-compatible endpoint) fails with the provider's error, shown by code.
  The capability is per provider, not per model.
- Unreferenced files (picked for a draft never sent) are swept at startup once
  they are a day old; deleting an agent deletes its attachments.
- PDFs and other documents are not attachable yet; the blocks and the Anthropic
  translation already allow them.
