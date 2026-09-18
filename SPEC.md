# Comitiva — Especificação

> **Comitiva — agentic chat for your whole team.**
>
> Este documento é a fonte de verdade sobre o que o produto é e como está organizado. O detalhamento técnico (classes, comandos, modelo de dados, fluxos) está em `docs/design.md`. O roadmap por fase está na seção 6; o estado atual em `docs/STATUS.md`.

### 1. Visão

Aplicação desktop open source onde o usuário cadastra **conexões** com LLMs (APIs ou harnesses de linha de comando como Claude Code e Codex), cria **agentes** com um papel e um conjunto de **ferramentas** (diretórios locais, Google Drive, qualquer servidor MCP), e conversa com todos eles em uma interface de **chat estilo Slack**, com várias conversas em paralelo. Mais tarde, um **hub** em Laravel permite times compartilharem agentes e conversas, e uma **interface web** acessa o hub sem o desktop.

O que não é: uma ferramenta de código. Nada no núcleo assume Git, repositórios ou terminal. Isso pode vir como servidor MCP como qualquer outra ferramenta.

### 2. Princípios

1. **Genérico por padrão.** Agentes podem pesquisar, escrever, revisar, organizar arquivos. Código é só um caso.
2. **O runner é o produto.** Toda a lógica de execução (adaptadores, loop de ferramentas, MCP, streaming, cancelamento, uso) vive em um processo Node independente com protocolo próprio. O Electron é um cliente dele. Qualquer outro shell (NativePHP, CLI, servidor) também pode ser.
3. **Local-first.** Sem hub, tudo funciona offline com SQLite. O hub é opcional e sincroniza.
4. **Segredos nunca em texto puro.** Chaves de API e tokens OAuth via `safeStorage` do Electron, fora do SQLite.
5. **O usuário vê e controla o que o agente faz com arquivos.** Leitura dentro das raízes é livre; escrita pede aprovação; fora das raízes é negado.
6. **Contrato compartilhado, código não.** Desktop (TS) e hub (PHP) compartilham os schemas JSON de mensagens, blocos, eventos e entidades, publicados em `packages/contract`. Cada lado implementa como for melhor no seu mundo.

### 3. Conceitos de domínio

```
Connection ──1:N──▶ Agent ──1:N──▶ Conversation ──1:N──▶ Message
                      │                                      │
                      ├── N:M ── ToolServer               UsageRecord
                      └── roots[] (diretórios + modo)
```

**Connection** — uma forma de chegar em um LLM.
`id`, `name`, `kind` (`api` | `cli`), `provider` (`anthropic`, `openai-compatible`, `google`, `ollama`, `claude-code`, `codex`, `gemini-cli`, …), `config` (JSON por provider), `secretRef`, `enabled`, `createdAt`. Ação: testar conexão.

**ToolServer** — um servidor MCP.
`id`, `name`, `transport` (`stdio` | `http`), `command`, `args`, `env` (valores sensíveis por `secretRef`), `url`, `headers`, `builtin` (bool), `enabled`. Embutidos na v1: `filesystem` e `google-drive`. O usuário pode cadastrar qualquer outro.

**Agent** — uma persona persistente.
`id`, `name`, `avatar`, `connectionId`, `model` (opcional), `role` (system prompt), `params`, `toolServerIds[]`, `roots[]` (`{ path, mode: 'read' | 'readwrite' }`), `permissionPolicy` (`ask` | `allow-writes` | `read-only`), `fallbackConnectionIds[]` (Fase 10), `tags`.

**Conversation** — `id`, `agentId`, `title`, `status` (`idle` | `running` | `awaiting-approval` | `error`), `harnessSessionId`, `archived`, `lastActivityAt`.

**Message** — `id`, `conversationId`, `role` (`user` | `assistant` | `tool`), `content: Block[]`, `status` (`streaming` | `complete` | `cancelled` | `error`), `createdAt`.
Blocos seguem o formato da Anthropic Messages API como canônico: `text`, `image`, `document`, `tool_use`, `tool_result`. Adaptadores traduzem para o formato do provider.

**ToolApproval** — registro de aprovação: `id`, `conversationId`, `toolUseId`, `toolServerId`, `toolName`, `input`, `decision` (`allow` | `deny` | `allow-always`), `decidedAt`.

**UsageRecord** — `id`, `connectionId`, `agentId`, `conversationId`, `messageId`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `estimated` (bool), `estimatedCostUsd`, `latencyMs`, `createdAt`.

### 4. Arquitetura

```
repo/
├── packages/
│   ├── contract/     # schemas zod + JSON Schema gerado: entidades, blocos, eventos, protocolo do runner
│   ├── runner/       # processo Node: adaptadores, MCP, loop de ferramentas, engine, uso. Sem Electron.
│   └── mcp-servers/  # servidores MCP embutidos: filesystem (com raízes), google-drive, documents (futuro)
├── apps/
│   ├── desktop/      # Electron: main (cliente do runner, SQLite, segredos, IPC) + renderer React
│   ├── hub/          # Fase 8: Laravel + Reverb + Postgres
│   └── web/          # Fase 9: React servido pelo hub, reaproveita componentes do desktop
├── docs/
├── SPEC.md
└── CLAUDE.md
```

**Stack desktop:** Electron + electron-vite, React 19, TypeScript strict, Tailwind, Zustand, SQLite via better-sqlite3 com migrations (ORM decidido em ADR), IPC tipado por zod, vitest, Playwright.

**Stack runner:** Node 22+, TypeScript, `@modelcontextprotocol/sdk`, SDK oficial da Anthropic, cliente OpenAI-compatible, cliente Gemini, fetch para Ollama. Sem dependência de Electron ou de banco: o runner é stateless quanto a persistência; recebe o histórico e devolve eventos. Quem persiste é o shell.

**Stack hub:** Laravel 12+, Reverb, Sanctum, Postgres, Pest. Implementa o `contract` em PHP (validação por JSON Schema gerado).

#### 4.1 Protocolo do runner

Processo filho do shell, JSON lines em stdin/stdout, uma linha por mensagem. O shell pode reiniciá-lo; o runner não guarda estado entre reinícios além de sessões MCP abertas.

Requisições (shell → runner):

```ts
type RunnerRequest =
  | { id; type: 'connection.test'; connection; secret? }
  | { id; type: 'connection.listModels'; connection; secret? }
  | { id; type: 'toolServer.start'; toolServer; secrets? }     // abre cliente MCP, retorna lista de tools
  | { id; type: 'toolServer.stop'; toolServerId }
  | { id; type: 'run.start'; runId; conversationId; agent; connection; secret?; messages: Message[]; harnessSessionId? }
  | { id; type: 'run.cancel'; runId }
  | { id; type: 'run.approval'; runId; toolUseId; decision: 'allow' | 'deny' | 'allow-always' }
  | { id; type: 'shutdown' }
```

Eventos (runner → shell), sempre com `runId` quando pertencem a um run:

```ts
type RunnerEvent =
  | { type: 'response'; id; ok: true; result } | { type: 'response'; id; ok: false; error }
  | { type: 'run.session'; runId; harnessSessionId }
  | { type: 'run.text_delta'; runId; text }
  | { type: 'run.block'; runId; block: Block }                   // bloco completo (image, tool_use...)
  | { type: 'run.tool_call'; runId; toolUseId; toolServerId; toolName; input; requiresApproval: boolean }
  | { type: 'run.tool_result'; runId; toolUseId; output; isError; durationMs }
  | { type: 'run.usage'; runId; inputTokens; outputTokens; cacheReadTokens?; cacheWriteTokens?; estimated }
  | { type: 'run.done'; runId; stopReason }
  | { type: 'run.error'; runId; message; retryable }
  | { type: 'log'; level; message }
```

#### 4.2 Adaptadores de conexão

```ts
interface ProviderAdapter {
  id: string; kind: 'api' | 'cli';
  capabilities: { streaming; tools; resume; listModels; usage; images };
  testConnection(config, secret?): Promise<TestResult>;
  listModels?(config, secret?): Promise<ModelInfo[]>;
  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent>;
}
```

`RunContext` dá ao adaptador `tools` (definições agregadas dos servidores MCP do agente) e `callTool(toolUseId, name, input)`, que já passa pela política de permissão e retorna o resultado ou uma negação.

- **API** (`anthropic`, `openai-compatible`, `google`, `ollama`): o runner controla o loop. Streaming → `tool_use` → `ctx.callTool` → `tool_result` → nova chamada, até `stopReason` sem ferramentas, com limite de iterações configurável.
- **CLI** (`claude-code`, `codex`, `gemini-cli`): o runner escreve um arquivo de configuração MCP temporário com os servidores do agente e passa ao binário (`--mcp-config` ou equivalente, verificado no `--help`), define `cwd` como a primeira raiz `readwrite` (ou um diretório isolado em `userData`), roda em modo não interativo com saída JSON stream, e traduz linhas para `AdapterEvent`. Aprovação de escrita: o harness roda com auto-accept e a política do agente é aplicada pelo servidor `filesystem` embutido, que pede aprovação ao shell via o próprio runner. Ferramentas nativas de arquivo do harness são desabilitadas quando possível, para que toda escrita passe pelo servidor embutido; quando não for possível, o usuário é avisado no formulário da conexão.

#### 4.3 Ferramentas e permissões

- O runner mantém um cliente MCP por `ToolServer` habilitado, iniciado sob demanda e reaproveitado entre runs.
- Servidor **`filesystem`** embutido: recebe as raízes e modos do agente por argumento; expõe `list`, `read`, `search`, `write`, `create`, `move`, `delete`. Qualquer caminho fora das raízes é rejeitado no servidor, não só na UI. Operações de escrita emitem pedido de aprovação, salvo `allow-always` já registrado para aquele agente e ferramenta.
- Servidor **`google-drive`** embutido: OAuth feito pelo desktop (loopback), tokens no `safeStorage`, injetados por env ao iniciar o servidor. Expõe `search`, `read` (com export de Google Docs/Sheets para texto), `create`, `update`, `move`. Escritas seguem a mesma política de aprovação.
- Servidores de terceiros: ferramentas classificadas como `readOnlyHint`/`destructiveHint` (anotações MCP) para decidir se pedem aprovação; sem anotações, pedem.
- Na UI: cada chamada de ferramenta é um bloco colapsável com nome, argumentos, resultado e duração. Pedido de aprovação é um card inline com **Permitir**, **Negar**, **Permitir sempre para este agente**. Enquanto aguarda, a conversa fica em `awaiting-approval` e a sidebar sinaliza.

#### 4.4 Fronteiras

- Renderer → `Backend` (interface): `LocalBackend` sobre IPC hoje; `RemoteBackend` sobre HTTP + WebSocket na Fase 8. UI não conhece nada além de `Backend`.
- Main → `RunnerClient`: único ponto que fala com o processo do runner. Persiste eventos, resolve segredos, aplica reinício.
- Hub → executa apenas conexões de API e servidores MCP `http`. Servidores `stdio` e harnesses de CLI só existem em desktops. Um desktop online pode se registrar como **runner do workspace** (Fase 9+) para executar esses em nome do time.

### 5. Interface do usuário

Três colunas, estilo Slack:

- **Sidebar**: agentes com avatar, status (ocioso / respondendo / aguardando aprovação / erro) e não lidas. Atalhos para Conexões, Ferramentas, Uso, Configurações.
- **Centro**: conversas do agente selecionado e o chat aberto. Markdown, código com copiar, blocos de ferramenta colapsáveis, cards de aprovação, cursor de streaming, cancelar, retry.
- **Painel direito**: detalhes do agente com role editável, raízes e ferramentas ativas, uso da conversa.
- **Composer**: Enter envia, Shift+Enter quebra linha, anexos de texto e imagem, `Cmd/Ctrl+K` para trocar de agente ou conversa.
- Tema claro/escuro; i18n desde o início (en, pt-BR).

### 6. Roadmap

| Fase | Entrega | Pronto quando |
|---|---|---|
| 0 | Monorepo, docs, CI, **spike**: runner mínimo com adaptador Anthropic + Electron mostrando duas conversas em streaming paralelo com cancelar | Spike funciona; decisão de arquitetura confirmada em ADR |
| 1 | Conexões de API completas, segredos seguros, tela de conexões | Quatro providers testam e listam modelos |
| 2 | Harnesses de CLI (Claude Code, Codex), resume de sessão | Turno com streaming e cancelamento nos dois |
| 3 | Agentes: CRUD, role, modelo, avatar | Agente aparece na sidebar |
| 4 | Chat completo com paralelismo, persistência, retry, auto-título | Dois agentes respondem ao mesmo tempo |
| 5 | Ferramentas: `ToolServer`, cliente MCP no runner, loop de ferramentas para API, servidor `filesystem` com raízes e aprovações, repasse de MCP aos harnesses | Agente lê e cria arquivo em diretório permitido, escrita pede aprovação, fora da raiz é negado |
| 5b | Google Drive: OAuth, servidor embutido, cadastro de servidores MCP de terceiros na UI | Agente lê um Google Doc e cria outro com aprovação |
| 6 | Uso: registros, preços, dashboard, export | Dashboard bate com os registros |
| 7 | Polimento e v0.1.0: anexos, busca, export/import, i18n, empacotamento, auto-update | Release publicada |
| 8 | Hub Laravel: auth, workspaces, sync de agentes e conversas, Reverb, `RemoteBackend` no desktop | Dois desktops veem a mesma conversa ao vivo |
| 9 | Web: mesma UI servida pelo hub, execução de API e MCP `http` no hub, chaves de time; desktop como runner de workspace | Usuário sem desktop conversa com agente de API do time |
| 10 | Políticas de uso: limites, concorrência, fallback e troca de conexão | Agente troca de conexão ao atingir limite |

### 7. Decisões em aberto (ADR na Fase 0)

ORM do desktop (drizzle vs kysely); licença (Apache-2.0 vs MIT); nome; como executar o runner (Node embarcado pelo Electron via `ELECTRON_RUN_AS_NODE` vs binário `node` separado); implementação do servidor `google-drive` (próprio vs comunidade).

---
