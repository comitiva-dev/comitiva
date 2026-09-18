import type {
  AgentParams,
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

export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  resume: boolean;
  listModels: boolean;
  usage: boolean;
  images: boolean;
}

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
}

export interface ToolResult {
  content: ToolResultContentBlock[];
  isError: boolean;
}

export interface RunContext {
  tools: ToolDef[];
  callTool(toolUseId: string, name: string, input: unknown): Promise<ToolResult>;
  log(level: 'debug' | 'info' | 'warn', msg: string): void;
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
