import type {
  Agent,
  AppErrorShape,
  ApprovalDecision,
  Block,
  Connection,
  Message,
  MessageStatus,
  PendingApproval,
  RunToolCallEvent,
  StopReason,
  ToolServerLaunch,
  UserContent,
} from '@comitiva/contract';

/**
 * Where a conversation's turns are persisted and published. The run engine
 * (RunEngine) is the same for Personal conversations and workspace ones;
 * the store is what differs:
 *
 * - LocalChatStore: SQLite, with events to this window over IPC.
 * - HubChatStore: the hub, with run events published in batches for every
 *   member to see (ADR 0017).
 */
export interface ChatStore {
  /** The agent as the runner sees it, and its connection. Throws not_found, agent_not_linked… */
  target(conversationId: string): Promise<RunTarget>;
  /** Refuses a retry before anything else when the store can tell (the last reply did not fail). */
  checkRetry?(conversationId: string): void;
  alwaysAllowed(agentId: string): string[];
  harnessSession(conversationId: string, connectionId: string): string | undefined;
  setHarnessSession(conversationId: string, sessionId: string, connectionId: string): void;
  /** Attachment file sources become base64 before a run (ADR 0012). */
  resolveHistory(messages: Message[]): Message[] | Promise<Message[]>;
  /**
   * Persists the user message and an empty streaming reply (or resets the
   * last, failed reply when `content` is null) and marks the conversation
   * running. Returns what the run starts from.
   */
  beginTurn(input: TurnInput): Promise<Turn>;
}

export interface RunTarget {
  agent: Agent;
  connection: Connection;
  /** The agent's MCP servers, resolved with their secrets for this run. */
  launches(): Promise<ToolServerLaunch[]>;
}

export interface TurnInput {
  conversationId: string;
  runId: string;
  content: UserContent | null;
  target: RunTarget;
}

export interface Turn {
  reply: Message;
  /** Every message before the reply, oldest first (buildHistory filters it for the runner). */
  history: Message[];
  session: RunSession;
}

/** The usage of a run, once it ended (cost is computed where it is recorded). */
export interface RunUsage {
  /** What the provider or harness actually ran, else the configured model. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimated: boolean;
  reportedCostUsd: number | null;
  latencyMs: number;
}

export interface RunOutcome {
  status: Extract<MessageStatus, 'complete' | 'cancelled' | 'error'>;
  blocks: Block[];
  error: AppErrorShape | null;
  stopReason: StopReason | null;
  usage: RunUsage | null;
}

/**
 * One live turn's persistence and publication. The engine calls it as the
 * runner's events arrive; the session decides how often to write and send.
 */
export interface RunSession {
  /** Streamed text, already appended to `blocks` (the reply so far). */
  text(delta: string, blocks: readonly Block[]): void;
  /** A complete block appended to the reply (tool_use, tool_result, image…). */
  block(block: Block, blocks: readonly Block[]): void;
  /** Every tool call the runner reports (with or without approval). */
  toolCall(event: RunToolCallEvent): void;
  /** The run waits for the user: the conversation becomes awaiting-approval. */
  awaitingApproval(pending: PendingApproval): void;
  /** The user answered on this machine; the conversation runs again. */
  decided(pending: PendingApproval, decision: ApprovalDecision): void | Promise<void>;
  /** Sends pending output now (a page read mid-stream, or before a decision). */
  flush(): void;
  /**
   * The final state, the usage record and the status, together. A store that
   * writes synchronously returns the message itself, so the title flow starts
   * before anything else can touch the conversation.
   */
  finish(outcome: RunOutcome): Message | null | Promise<Message | null>;
  /** Drops the session without writing anything (the agent is being deleted). */
  close(): void;
  /**
   * After a complete reply: the first user message and the placeholder title
   * when this reply is the conversation's first, so a generated title can
   * replace it. Null otherwise.
   */
  titleCandidate(reply: Message): { user: Message; placeholder: string | null } | null;
  /** Replaces the placeholder with a generated title, unless someone renamed it meanwhile. */
  applyTitle(title: string, placeholder: string | null): void | Promise<void>;
}
