# Comitiva

**Agentic chat for your whole team.**

Comitiva is an open source desktop app where you connect LLMs (APIs such as Anthropic, OpenAI-compatible, Gemini and Ollama, or command-line harnesses such as Claude Code and Codex), create agents with a role and a set of tools (local folders, Google Drive, any MCP server), and talk to all of them in a Slack-style chat with many conversations running in parallel. A self-hostable hub for teams and a web UI come later.

It is not a coding tool. Agents research, write, review and organize files; code is just one case.

> **Status: Phase 5.** API connections (Anthropic, OpenAI-compatible, Gemini, Ollama) and CLI harnesses (Claude Code, Codex), agents, and a chat with many conversations running at once. Agents use tools through MCP: the built-in Files server works only inside the folders you give each agent, anything that changes a file asks you first, and you can add any MCP server. Google Drive comes next. See [docs/STATUS.md](docs/STATUS.md) and the roadmap in [SPEC.md](SPEC.md#6-roadmap).

## How it is built

```
Renderer (React) ──Backend──▶ Preload ──IPC──▶ Electron main ──JSON lines (stdio)──▶ Runner (Node) ──▶ LLM providers
                                                   │
                                          SQLite · safeStorage secrets
```

- **The runner is the product.** All LLM execution (adapters, streaming, cancellation, usage, the tool loop, MCP clients and approvals) lives in `packages/runner`, a plain Node process with its own JSON-lines protocol. Electron is just one client of it.
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

Open **Connections**, press **Add connection**, pick a provider, paste a key (none is needed for Ollama or LM Studio), press **Fetch models** and **Test**, then **Save**.

```bash
pnpm lint && pnpm typecheck && pnpm test   # all checks
pnpm --filter desktop test:e2e             # end-to-end, no API key needed (fake providers)
pnpm package                               # build an installer for your platform
```

## Repository layout

| Path | Package | What |
|---|---|---|
| `packages/contract` | `@comitiva/contract` | Entities, blocks, runner protocol and IPC schemas; JSON Schema output |
| `packages/runner` | `@comitiva/runner` | Runner process, `RunnerClient`, provider adapters ([how to add one](docs/providers.md)) |
| `packages/mcp-servers` | `@comitiva/mcp-servers` | Built-in MCP servers: filesystem (with roots); Google Drive in Phase 5b |
| `apps/desktop` | `desktop` | Electron app |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
