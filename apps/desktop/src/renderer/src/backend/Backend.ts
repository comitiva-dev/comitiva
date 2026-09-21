import type {
  Agent,
  AgentDraft,
  AgentPatch,
  AppSettings,
  AppSettingsPatch,
  CliDetectResult,
  ConnectionDraft,
  ConnectionPatch,
  ConnectionSummary,
  ConnectionTarget,
  Conversation,
  ConversationListInput,
  ConversationSummary,
  DetectBinaryInput,
  IpcEventPayload,
  ErrorCode,
  MessagePage,
  ModelInfo,
  RunnerStatus,
  SecretStorageStatus,
  TestResult,
  UserContent,
} from '@comitiva/contract';

/**
 * The only thing the UI knows about. LocalBackend implements it over IPC
 * today; RemoteBackend (Phase 8) will implement it over HTTP + WebSocket.
 * It grows phase by phase (docs/design.md §7; the seam: docs/architecture.md).
 */
export interface Backend {
  app: {
    getVersion(): Promise<string>;
  };
  runner: {
    getStatus(): Promise<RunnerStatus>;
  };
  secrets: {
    getStatus(): Promise<SecretStorageStatus>;
  };
  connections: {
    list(): Promise<ConnectionSummary[]>;
    create(draft: ConnectionDraft): Promise<ConnectionSummary>;
    update(id: string, patch: ConnectionPatch): Promise<ConnectionSummary>;
    delete(id: string): Promise<void>;
    /** Resolves with `{ ok: false, error }` for provider failures; rejects only for bad input. */
    test(target: ConnectionTarget): Promise<TestResult>;
    listModels(target: ConnectionTarget): Promise<ModelInfo[]>;
    /** CLI harnesses: finds the binary (typed path or PATH) and reads its version. */
    detectBinary(input: DetectBinaryInput): Promise<CliDetectResult>;
  };
  agents: {
    list(): Promise<Agent[]>;
    /** Rejects with not_found, connection_disabled or model_required when the agent could not run. */
    create(draft: AgentDraft): Promise<Agent>;
    update(id: string, patch: AgentPatch): Promise<Agent>;
    delete(id: string): Promise<void>;
    /** `name` is the copy's (localized) name. */
    duplicate(id: string, name?: string): Promise<Agent>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: AppSettingsPatch): Promise<AppSettings>;
  };
  conversations: {
    /** Non-archived by default, newest activity first, with unread replies. */
    list(filter?: ConversationListInput): Promise<ConversationSummary[]>;
    create(agentId: string): Promise<Conversation>;
    rename(id: string, title: string): Promise<Conversation>;
    archive(id: string, archived: boolean): Promise<Conversation>;
    markRead(id: string): Promise<void>;
  };
  messages: {
    /** The latest page (or the one before `beforeSeq`), oldest first, at the conversation's `rev`. */
    list(
      conversationId: string,
      opts?: { beforeSeq?: number; limit?: number },
    ): Promise<MessagePage>;
    /**
     * Resolves once the message is stored and the run started; the reply
     * arrives as events. Rejects with conversation_busy, connection_disabled,
     * model_required or secret_missing, having stored nothing.
     */
    send(conversationId: string, content: UserContent): Promise<void>;
    cancel(conversationId: string): Promise<void>;
    /** Runs the last errored reply again, in the same message. */
    retry(conversationId: string): Promise<void>;
  };
  dialogs: {
    /** A native folder picker; null when cancelled (or when the backend has none). */
    pickFolder(): Promise<string | null>;
  };
  onEvent(handler: (event: BackendEvent) => void): () => void;
}

/**
 * Pushed by the backend. Message events carry the conversation's `rev`
 * (ADR 0008): drop those at or below the `rev` of the page already shown.
 */
export type BackendEvent =
  | { type: 'runner.status'; status: RunnerStatus }
  | ({ type: 'conversation.updated' } & IpcEventPayload<'conversation.updated'>)
  | ({ type: 'message.updated' } & IpcEventPayload<'message.updated'>)
  | ({ type: 'message.delta' } & IpcEventPayload<'message.delta'>)
  | ({ type: 'message.block' } & IpcEventPayload<'message.block'>);

export type MessageEvent = Extract<
  BackendEvent,
  { type: 'message.updated' | 'message.delta' | 'message.block' }
>;

/** Error thrown by Backend calls; the UI shows it by `code`, never by message. */
export class BackendError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/** Errors from a Backend call carry a stable code when one is known. */
export function errorCode(err: unknown): ErrorCode {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? (code as ErrorCode) : 'internal';
}
