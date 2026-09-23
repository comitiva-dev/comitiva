import type {
  Agent,
  AgentDraft,
  AgentPatch,
  ApprovalDecision,
  AppSettings,
  AppSettingsPatch,
  AttachmentBlock,
  AttachmentInput,
  SearchInput,
  SearchResult,
  CliDetectResult,
  ConnectionDraft,
  ConnectionPatch,
  ConnectionSummary,
  ConnectionTarget,
  Conversation,
  ConversationListInput,
  ConversationSummary,
  ImportReport,
  DetectBinaryInput,
  IpcEventPayload,
  ErrorCode,
  MessagePage,
  ModelInfo,
  RunnerStatus,
  SecretStorageStatus,
  TestResult,
  ToolDef,
  ToolServerTestTarget,
  GoogleDriveConfigureInput,
  GoogleDriveStatus,
  ToolServer,
  ToolServerDraft,
  ToolServerPatch,
  UserContent,
  ModelPrice,
  ModelPrices,
  ProviderId,
  UsageBucket,
  UsageRange,
  UsageSummary,
  UsageTotals,
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
    /** Saves it as Markdown through a save dialog; the path, or null when cancelled. */
    exportMarkdown(id: string): Promise<string | null>;
  };
  bundle: {
    /** Agents (all, or those listed) with their connections and tool servers, no secrets. */
    export(agentIds?: string[]): Promise<string | null>;
    /** Picks a bundle and imports it as new objects; null when cancelled. */
    import(): Promise<ImportReport | null>;
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
  search: {
    /** Conversations by title and messages by content, archived ones left out. */
    query(input: SearchInput): Promise<SearchResult>;
  };
  attachments: {
    /**
     * Stores a file picked in the composer and returns its block. Rejects
     * with attachment_too_large or unsupported_attachment.
     */
    add(input: AttachmentInput): Promise<AttachmentBlock>;
    /** Where the UI loads a stored attachment from (an image in a message). */
    url(path: string): string;
  };
  dialogs: {
    /** A native folder picker; null when cancelled (or when the backend has none). */
    pickFolder(): Promise<string | null>;
  };
  toolServers: {
    /** Built-ins first. Secret values never come back, only refs. */
    list(): Promise<ToolServer[]>;
    create(draft: ToolServerDraft): Promise<ToolServer>;
    /** Built-ins accept only `enabled`. */
    update(id: string, patch: ToolServerPatch): Promise<ToolServer>;
    delete(id: string): Promise<void>;
    /**
     * Starts a saved server (`{ id }`) or unsaved form settings (`{ spec, id? }`)
     * and lists its tools; rejects with tool_server_failed, secret_missing or,
     * for Google Drive, google_not_connected / google_reconnect_required.
     */
    test(target: ToolServerTestTarget): Promise<ToolDef[]>;
  };
  /** The Google account behind the built-in Drive server. Tokens never reach the UI. */
  googleDrive: {
    getStatus(): Promise<GoogleDriveStatus>;
    /** The user's own OAuth client; a different client id disconnects. */
    configure(input: GoogleDriveConfigureInput): Promise<GoogleDriveStatus>;
    /**
     * Opens Google's consent page in the browser and resolves once the account
     * is connected. Rejects with oauth_not_configured, oauth_cancelled,
     * oauth_failed or timeout.
     */
    connect(): Promise<GoogleDriveStatus>;
    cancelConnect(): Promise<void>;
    disconnect(): Promise<GoogleDriveStatus>;
  };
  usage: {
    /** Totals plus the tables by connection, agent and model, in one call. */
    summary(range: UsageRange): Promise<UsageSummary>;
    /** One point per day in the range, including the days nothing ran. */
    timeseries(range: UsageRange): Promise<UsageBucket[]>;
    /** What one conversation has used so far. */
    conversation(conversationId: string): Promise<UsageTotals>;
    /** Writes a CSV where the user picks; resolves null when they cancel. */
    export(input: UsageRange & { shape?: 'records' | 'summary' }): Promise<string | null>;
    /** Every model seen in the records, with the price in force for it. */
    prices(): Promise<ModelPrice[]>;
    /** Corrects a price and recosts that model's records. Returns the new list. */
    setPrice(provider: ProviderId, model: string, prices: ModelPrices): Promise<ModelPrice[]>;
    clearPrice(provider: ProviderId, model: string): Promise<ModelPrice[]>;
  };
  approvals: {
    /** Answers the conversation's pending tool call. */
    decide(conversationId: string, toolUseId: string, decision: ApprovalDecision): Promise<void>;
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
