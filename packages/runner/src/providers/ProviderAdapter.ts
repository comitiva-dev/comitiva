import type {
  AgentParams,
  Capabilities,
  Connection,
  ConnectionKind,
  Message,
  ModelInfo,
  ProviderId,
  RunEventPayload,
  TestResult,
  ToolDef,
  ToolResultContentBlock,
} from '@comitiva/contract';

export type { Capabilities } from '@comitiva/contract';

/** Events an adapter yields; the Run stamps them with `runId` and `ts`. */
export type AdapterEvent = RunEventPayload;

export interface RunInput {
  connection: Connection;
  secret: string | undefined;
  model: string;
  /** The agent's role, sent as the system prompt. */
  system: string;
  params: AgentParams;
  messages: Message[];
  harnessSessionId: string | undefined;
  /** CLI harnesses: where the harness runs (resolved by the shell). */
  workingDirectory?: string | undefined;
}

export interface ToolResult {
  content: ToolResultContentBlock[];
  isError: boolean;
}

export interface RunContext {
  /** Tools from the agent's MCP servers, with prefixed names (`fs__read_file`). */
  tools: ToolDef[];
  /** The server a (prefixed) tool name belongs to, for `tool_use` blocks; '' when unknown. */
  toolServerId(name: string): string;
  /**
   * Calls a tool through the permission gate (it may wait for the user's
   * approval). Never throws for tool failures or denials: those come back as
   * `isError` results for the model. Rejects only when the run is cancelled.
   */
  callTool(toolUseId: string, name: string, input: unknown): Promise<ToolResult>;
  /**
   * CLI harnesses: an MCP config that points the harness at the runner's tool
   * proxy (ADR 0009), or undefined when the agent has no tools. The caller
   * calls `cleanup()` when the turn ends.
   */
  mcpConfigForCli?(): Promise<CliMcpConfig | undefined>;
  log(level: 'debug' | 'info' | 'warn', msg: string): void;
}

/** What a CLI harness needs to reach the runner's tools during one turn. */
export interface CliMcpConfig {
  /** JSON file in Claude Code's `--mcp-config` format (mode 0600). */
  path: string;
  /** The proxy command, for harnesses configured by flags (Codex `-c mcp_servers.…`). */
  command: string;
  args: string[];
  /** Env the harness must pass to the proxy (the per-run token). */
  env: Record<string, string>;
  /** Server name in the config: tools appear to the harness as `mcp__<name>__<tool>`. */
  serverName: string;
  /** True when the agent has the built-in filesystem server (native file tools get disabled). */
  hasFilesystem: boolean;
  cleanup(): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly kind: ConnectionKind;
  readonly capabilities: Capabilities;
  testConnection(connection: Connection, secret?: string): Promise<TestResult>;
  listModels?(connection: Connection, secret?: string): Promise<ModelInfo[]>;
  /**
   * Streams one turn. On abort the adapter should yield the usage it has and
   * `done { stopReason: 'cancelled' }`; the Run guarantees a terminal event
   * either way.
   */
  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent>;
}
