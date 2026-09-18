# Comitiva

Agentic chat for your whole team. Open source desktop app (Electron + TypeScript) where users register LLM connections (APIs or CLI harnesses such as Claude Code and Codex), create agents with a role and a set of tools (local folders, Google Drive, any MCP server), and talk to all of them in a Slack-style chat with many conversations running in parallel. Later: a Laravel hub for teams and a web UI.

## Read first

- `SPEC.md` — what the product is, domain model, architecture, roadmap by phase. Source of truth.
- `docs/design.md` — how it is built: file layout, package names, data model, classes and methods, runner protocol, flows, commands. Follow it unless there is a reason to deviate; if you deviate, say so and update it in the same commit.
- `docs/STATUS.md` — what is done and what is next. Update at the end of every phase.
- `docs/adr/` — one file per decision that affects more than one package.

## Non-negotiable rules

- `packages/runner` and `packages/mcp-servers` have zero Electron dependencies. They are plain Node processes with a JSON-lines protocol.
- Secrets never touch SQLite, IPC payloads to the renderer, or logs. Only `secretRef` travels; values go to the runner per request and are not persisted there.
- The renderer depends only on the `Backend` interface, never on IPC or the runner directly.
- The filesystem MCP server rejects any path outside the agent's roots at the server level, including symlink escapes.
- Implementation order inside a phase: contract → runner → main → renderer, with tests at each layer before the next.
- Nothing in the core assumes code, Git or terminals. Comitiva is generic.

## Conventions

- TypeScript strict, pnpm workspaces, turborepo. Package names `@comitiva/*`.
- Conventional commits with package scope: `feat(runner): ...`, `fix(desktop): ...`, `docs: ...`.
- Errors carry stable codes (`AppError`); the UI translates by code and never shows raw provider messages as titles.
- Code, comments, commits and docs in English. UI strings go through i18n (en, pt-BR).
- Plan before coding. When something is ambiguous, ask instead of guessing product decisions.

## Commands

See `docs/design.md` section 8. The short version: `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm contract:schema`, `pnpm package`.
