# Comitiva

**Agentic chat for your whole team.**

Comitiva is an open source desktop app where you connect LLMs (APIs such as Anthropic, OpenAI-compatible, Gemini and Ollama, or command-line harnesses such as Claude Code and Codex), create agents with a role and a set of tools (local folders, Google Drive, any MCP server), and talk to all of them in a Slack-style chat with many conversations running in parallel. A self-hostable hub for teams and a web UI come later.

It is not a coding tool. Agents research, write, review and organize files; code is just one case.

> **Status: Phase 0.** The monorepo, CI and an architecture spike are in place. Two Anthropic conversations stream in parallel through a standalone runner process, with independent cancel. See [docs/STATUS.md](docs/STATUS.md) and the roadmap in [SPEC.md](SPEC.md#6-roadmap).

## How it is built

```
Renderer (React) ──Backend──▶ Preload ──IPC──▶ Electron main ──JSON lines (stdio)──▶ Runner (Node) ──▶ LLM providers
                                                   │
                                          SQLite · safeStorage secrets
```

- **The runner is the product.** All LLM execution (adapters, streaming, cancellation, usage, and later tools and MCP) lives in `packages/runner`, a plain Node process with its own JSON-lines protocol. Electron is just one client of it.
- **Local-first.** Everything works offline with SQLite. Secrets live in the OS keychain via Electron `safeStorage`, never in the database.
- **Shared contract.** `packages/contract` holds zod schemas and generated JSON Schema, which the future Laravel hub will consume.

Read more in [docs/architecture.md](docs/architecture.md), [docs/design.md](docs/design.md) and [docs/adr/](docs/adr/).

## Getting started

Requirements: Node 24 (see `.nvmrc`; Node ≥ 22 works for the packages), pnpm 10 (`corepack enable`), and on Linux the usual build tools for native modules.

```bash
corepack enable
pnpm install
pnpm dev            # on Ubuntu 24.04+: pnpm dev -- --noSandbox (see CONTRIBUTING.md)
```

In the spike window, paste an Anthropic API key, press **Save**, then type a message in both panes and press **Send** in each. Cancel one while the other keeps streaming.

```bash
pnpm lint && pnpm typecheck && pnpm test   # all checks
pnpm --filter desktop test:e2e             # end-to-end, no API key needed (fake provider)
pnpm package                               # build an installer for your platform
```

## Repository layout

| Path | Package | What |
|---|---|---|
| `packages/contract` | `@comitiva/contract` | Entities, blocks, runner protocol and IPC schemas; JSON Schema output |
| `packages/runner` | `@comitiva/runner` | Runner process, `RunnerClient`, provider adapters |
| `packages/mcp-servers` | `@comitiva/mcp-servers` | Built-in MCP servers (filesystem, Google Drive) — upcoming |
| `apps/desktop` | `desktop` | Electron app |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
