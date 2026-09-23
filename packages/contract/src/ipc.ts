import { z } from 'zod';
import { Id, IsoDate } from './common.js';
import {
  Agent,
  AgentAvatar,
  AgentParams,
  AgentRoot,
  AgentTags,
  PermissionPolicy,
} from './entities/agent.js';
import { Connection } from './entities/connection.js';
import { Conversation } from './entities/conversation.js';
import { Message, MessageRole } from './entities/message.js';
import { ApprovalDecision } from './entities/tool-approval.js';
import { ToolServer } from './entities/tool-server.js';
import { ATTACHMENT_LIMITS, Block, DocumentBlock, ImageBlock, TextBlock } from './blocks.js';
import { ErrorCode, type AppErrorShape } from './errors.js';
import {
  AnthropicConfig,
  CliConfig,
  CodexConfig,
  GoogleConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
  ProviderId,
} from './provider-config.js';
import { CliDetectResult, ModelInfo, TestResult, ToolDef } from './runner-protocol.js';

export { ipcEventChannels, ipcInvokeChannels } from './ipc-channels.js';

/**
 * Desktop IPC contract: renderer ⇄ main. Every invoke channel has an input and
 * an output schema; main validates inputs before calling services and strips
 * outputs to their schema, so secret values never reach the renderer.
 */

export const RunnerStatus = z.enum(['starting', 'ready', 'restarting', 'stopped']);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

/** One variant per API provider, each with its typed config plus `extra` fields. */
function apiProviderVariants<T extends z.ZodRawShape>(extra: T) {
  return [
    z.object({ ...extra, provider: z.literal('anthropic'), config: AnthropicConfig }),
    z.object({
      ...extra,
      provider: z.literal('openai-compatible'),
      config: OpenAICompatibleConfig,
    }),
    z.object({ ...extra, provider: z.literal('google'), config: GoogleConfig }),
    z.object({ ...extra, provider: z.literal('ollama'), config: OllamaConfig }),
  ] as const;
}

/** One variant per CLI harness. They never take a key: the harness uses its own login. */
function cliProviderVariants<T extends z.ZodRawShape>(extra: T) {
  return [
    z.object({ ...extra, provider: z.literal('claude-code'), config: CliConfig }),
    z.object({ ...extra, provider: z.literal('codex'), config: CodexConfig }),
  ] as const;
}

/** An API key typed by the user. Travels renderer → main only, never back. */
const ApiKey = z.string().trim().min(1);

/** A new connection as the form submits it. `kind` is derived from the provider. */
const draftBase = { name: z.string().trim().min(1), enabled: z.boolean().optional() };
export const ConnectionDraft = z.discriminatedUnion('provider', [
  ...apiProviderVariants({ ...draftBase, apiKey: ApiKey.optional() }),
  ...cliProviderVariants(draftBase),
]);
export type ConnectionDraft = z.infer<typeof ConnectionDraft>;

/** Provider settings to test or list models with before (or without) saving. */
export const ConnectionProbe = z.discriminatedUnion('provider', [
  ...apiProviderVariants({ apiKey: ApiKey.optional() }),
  ...cliProviderVariants({}),
]);
export type ConnectionProbe = z.infer<typeof ConnectionProbe>;

/**
 * Changes to a saved connection. `config` replaces the whole config and is
 * validated against the connection's provider. `apiKey`: omitted keeps the
 * stored key, a string replaces it, `null` removes it.
 */
export const ConnectionPatch = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  apiKey: ApiKey.nullable().optional(),
});
export type ConnectionPatch = z.infer<typeof ConnectionPatch>;

/**
 * What to test or list models for: a saved connection (`id`), unsaved settings
 * (`probe`), or both (edit form: probe settings, stored key unless the probe
 * carries a new one).
 */
export const ConnectionTarget = z
  .object({ id: Id.optional(), probe: ConnectionProbe.optional() })
  .refine((v) => v.id !== undefined || v.probe !== undefined, 'id or probe is required');
export type ConnectionTarget = z.infer<typeof ConnectionTarget>;

export const ConnectionTestRecord = z.object({
  at: IsoDate,
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  errorCode: ErrorCode.nullable(),
});
export type ConnectionTestRecord = z.infer<typeof ConnectionTestRecord>;

/** A connection as the UI sees it: never the key, only whether one is stored. */
export const ConnectionSummary = z.object({
  connection: Connection,
  hasSecret: z.boolean(),
  lastTest: ConnectionTestRecord.nullable(),
});
export type ConnectionSummary = z.infer<typeof ConnectionSummary>;

export const SecretStorageStatus = z.object({
  /** False when keys cannot be stored securely (e.g. Linux without a keyring). */
  available: z.boolean(),
  /** True when the OS offers only obfuscation (Linux `basic_text`) and it was opted into. */
  weak: z.boolean(),
});
export type SecretStorageStatus = z.infer<typeof SecretStorageStatus>;

/** Where to look for a CLI harness: the typed path, or PATH and the usual install dirs. */
export const DetectBinaryInput = z.object({
  provider: z.enum(['claude-code', 'codex']),
  binaryPath: z.string().trim().min(1).optional(),
});
export type DetectBinaryInput = z.infer<typeof DetectBinaryInput>;

/** A model id typed or picked by the user; blank means "use the connection's default". */
const AgentModel = z
  .string()
  .trim()
  .nullable()
  .transform((m) => (m ? m : null));

const agentFields = {
  name: z.string().trim().min(1),
  avatar: AgentAvatar,
  connectionId: Id,
  model: AgentModel,
  role: z.string(),
  params: AgentParams,
  tags: AgentTags,
  // In the schema from Phase 3; edited in the UI from Phase 5.
  toolServerIds: z.array(Id),
  roots: z.array(AgentRoot),
  permissionPolicy: PermissionPolicy,
};

/** A new agent as the form submits it. */
export const AgentDraft = z.object({
  ...agentFields,
  model: AgentModel.optional().transform((m) => m ?? null),
  role: agentFields.role.default(''),
  params: agentFields.params.default({}),
  tags: agentFields.tags.default([]),
  toolServerIds: agentFields.toolServerIds.default([]),
  roots: agentFields.roots.default([]),
  permissionPolicy: agentFields.permissionPolicy.default('ask'),
});
/** What callers send (defaults may be omitted). */
export type AgentDraft = z.input<typeof AgentDraft>;
/** What main receives after validation. */
export type ValidAgentDraft = z.output<typeof AgentDraft>;

/** Changes to a saved agent; omitted fields are kept. */
export const AgentPatch = z.object(agentFields).partial();
export type AgentPatch = z.input<typeof AgentPatch>;
export type ValidAgentPatch = z.output<typeof AgentPatch>;

/** App-wide preferences kept in the local database. */
export const AppSettings = z.object({
  /** The first-run offer to create a sample agent: shown until accepted or dismissed. */
  sampleAgentOffer: z.enum(['pending', 'done']).default('pending'),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const AppSettingsPatch = z
  .object({ sampleAgentOffer: z.enum(['pending', 'done']) })
  .partial();
export type AppSettingsPatch = z.infer<typeof AppSettingsPatch>;

const ById = z.object({ id: Id });

/**
 * An env var or header value as the form submits it: a plain value, a new
 * secret (stored in the SecretStore, never in SQLite), or, when editing, the
 * stored secret kept as is. Secret values never come back to the renderer.
 */
export const ToolServerValueInput = z.union([
  z.object({ value: z.string() }),
  z.object({ secret: z.string().min(1) }),
  z.object({ keepSecret: z.literal(true) }),
]);
export type ToolServerValueInput = z.infer<typeof ToolServerValueInput>;

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid environment variable name');
const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid header name');

/** How to reach a third-party MCP server. */
export const ToolServerSpec = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(EnvName, ToolServerValueInput).default({}),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(HeaderName, ToolServerValueInput).default({}),
  }),
]);
export type ToolServerSpec = z.input<typeof ToolServerSpec>;

/** A new third-party MCP server. */
export const ToolServerDraft = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  spec: ToolServerSpec,
});
export type ToolServerDraft = z.input<typeof ToolServerDraft>;
export type ValidToolServerDraft = z.output<typeof ToolServerDraft>;

/** Changes to a server. Built-ins accept only `enabled`; `spec` replaces the whole spec. */
export const ToolServerPatch = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  spec: ToolServerSpec.optional(),
});
export type ToolServerPatch = z.input<typeof ToolServerPatch>;
export type ValidToolServerPatch = z.output<typeof ToolServerPatch>;

/**
 * What `toolServers.test` starts: a saved server (`{ id }`), or the form's
 * unsaved settings (`{ spec }`, plus `id` when editing so `keepSecret` values
 * reuse the stored secrets).
 */
export const ToolServerTestTarget = z.union([
  z.object({ spec: ToolServerSpec, id: Id.optional() }),
  z.object({ id: Id }),
]);
export type ToolServerTestTarget = z.input<typeof ToolServerTestTarget>;
export type ValidToolServerTestTarget = z.output<typeof ToolServerTestTarget>;

/**
 * The built-in Google Drive server's account, as the UI sees it. Tokens and
 * the client secret never leave main; only the client id (not a secret) and
 * the account email do.
 */
export const GoogleDriveState = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnect_required',
]);
export type GoogleDriveState = z.infer<typeof GoogleDriveState>;

export const GoogleDriveStatus = z.object({
  /** A client id is stored (the secret is optional for some client types). */
  clientConfigured: z.boolean(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  state: GoogleDriveState,
  email: z.string().nullable(),
});
export type GoogleDriveStatus = z.infer<typeof GoogleDriveStatus>;

/**
 * The user's own OAuth client (type "Desktop app"). `clientSecret` omitted or
 * `{ keepSecret }` keeps the stored one; `{ value }` replaces it. A different
 * client id disconnects the account.
 */
export const GoogleDriveConfigureInput = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z
    .union([
      z.object({ value: z.string().trim().min(1) }),
      z.object({ keepSecret: z.literal(true) }),
    ])
    .optional(),
});
export type GoogleDriveConfigureInput = z.input<typeof GoogleDriveConfigureInput>;

/**
 * A tool call waiting for the user's decision. At most one per conversation
 * (tools run one at a time). Live state: it lasts as long as the run.
 */
export const PendingApproval = z.object({
  toolUseId: z.string(),
  toolServerId: Id,
  toolName: z.string(),
  input: z.unknown(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

/** A conversation as a list shows it: the entity plus unread replies (local, per user). */
export const ConversationSummary = z.object({
  conversation: Conversation,
  unread: z.number().int().nonnegative(),
  pendingApproval: PendingApproval.nullable().default(null),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationListInput = z
  .object({ agentId: Id.optional(), archived: z.boolean().default(false) })
  .default({ archived: false });
export type ConversationListInput = z.input<typeof ConversationListInput>;

/** What a user sends: text, images and documents (tool blocks come only from runs). */
export const UserContent = z
  .array(z.discriminatedUnion('type', [TextBlock, ImageBlock, DocumentBlock]))
  .min(1)
  .refine(
    (blocks) => blocks.some((b) => b.type !== 'text' || b.text.trim() !== ''),
    'message is empty',
  )
  .refine(
    (blocks) => blocks.filter((b) => b.type !== 'text').length <= ATTACHMENT_LIMITS.perMessage,
    `at most ${ATTACHMENT_LIMITS.perMessage} attachments per message`,
  );
export type UserContent = z.infer<typeof UserContent>;

export const MessageListInput = z.object({
  conversationId: Id,
  /** Only messages with a lower seq (older pages). */
  beforeSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type MessageListInput = z.input<typeof MessageListInput>;

/**
 * A page of messages, oldest first. `rev` is the conversation's event
 * revision the page reflects: message events with `rev <= page.rev` are
 * already included and must be dropped (ADR 0008).
 */
export const MessagePage = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
  rev: z.number().int().nonnegative(),
});
export type MessagePage = z.infer<typeof MessagePage>;

const ByConversation = z.object({ conversationId: Id });

// ------------------------------------------------------------------- usage

/**
 * A closed-open window of time, plus the viewer's offset from UTC in minutes
 * (`-new Date().getTimezoneOffset()`), so days are bucketed on the user's
 * calendar and not on UTC's.
 */
export const UsageRange = z.object({
  from: IsoDate,
  to: IsoDate,
  tzOffsetMinutes: z.number().int().min(-840).max(840).default(0),
});
export type UsageRange = z.input<typeof UsageRange>;

/**
 * Summed usage. `costUsd` is what API connections cost; `costUsdCli` is the
 * *equivalent* API cost of CLI harness runs, which a subscription may not
 * bill at all, so the two are never added together for the user.
 */
export const UsageTotals = z.object({
  runs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  costUsdCli: z.number().nonnegative(),
  /** Some rows counted tokens locally instead of taking the provider's number. */
  anyEstimated: z.boolean(),
  /** Some rows have no price for their model, so the cost is short. */
  anyUnpriced: z.boolean(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** One row of a grouped table. `label` is resolved by main; ids may be gone. */
export const UsageSummaryRow = UsageTotals.extend({
  key: z.string(),
  label: z.string(),
  /** Set for the by-model grouping; the provider the model ran on. */
  provider: ProviderId.nullable().default(null),
  /** True when the subject (agent, connection) no longer exists. */
  deleted: z.boolean().default(false),
});
export type UsageSummaryRow = z.infer<typeof UsageSummaryRow>;

export const UsageSummary = z.object({
  totals: UsageTotals,
  byConnection: z.array(UsageSummaryRow),
  byAgent: z.array(UsageSummaryRow),
  byModel: z.array(UsageSummaryRow),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/** One day on the viewer's calendar, `YYYY-MM-DD`. */
export const UsageBucket = UsageTotals.extend({ day: z.string() });
export type UsageBucket = z.infer<typeof UsageBucket>;

/** Prices in US dollars per million tokens. */
export const ModelPrices = z.object({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  cacheReadPer1M: z.number().nonnegative().nullable().default(null),
  cacheWritePer1M: z.number().nonnegative().nullable().default(null),
});
export type ModelPrices = z.infer<typeof ModelPrices>;

/** A model seen in the records, with the prices in force for it. */
export const ModelPrice = z.object({
  provider: ProviderId,
  model: z.string(),
  prices: ModelPrices.nullable(),
  source: z.enum(['table', 'override', 'none']),
  runs: z.number().int().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const UsageExportInput = UsageRange.extend({
  /** `records`: one row per run. `summary`: the grouped tables. */
  shape: z.enum(['records', 'summary']).default('records'),
});
export type UsageExportInput = z.input<typeof UsageExportInput>;

/**
 * A file the user attaches in the composer. `dataBase64` is the file's bytes;
 * main checks the size and the type (sniffing images) and stores it.
 */
export const AttachmentInput = z.object({
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().max(255),
  dataBase64: z.string(),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;

/** A stored attachment, ready to go into a message. */
export const AttachmentBlock = z.discriminatedUnion('type', [ImageBlock, DocumentBlock]);
export type AttachmentBlock = z.infer<typeof AttachmentBlock>;

/** Quick switcher search: words, matched as prefixes, diacritics ignored. */
export const SearchInput = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchInput = z.input<typeof SearchInput>;

/** A match in context: the renderer highlights `match` pieces (never HTML). */
export const SearchSnippet = z.array(z.object({ text: z.string(), match: z.boolean() }));
export type SearchSnippet = z.infer<typeof SearchSnippet>;

export const MessageHit = z.object({
  conversationId: Id,
  agentId: Id,
  messageId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  createdAt: IsoDate,
  conversationTitle: z.string().nullable(),
  snippet: SearchSnippet,
});
export type MessageHit = z.infer<typeof MessageHit>;

export const ConversationHit = z.object({
  conversationId: Id,
  agentId: Id,
  title: z.string(),
  lastActivityAt: IsoDate,
});
export type ConversationHit = z.infer<typeof ConversationHit>;

/** Archived conversations are left out, as in the sidebar. */
export const SearchResult = z.object({
  conversations: z.array(ConversationHit),
  messages: z.array(MessageHit),
});
export type SearchResult = z.infer<typeof SearchResult>;

const ByModel = z.object({ provider: ProviderId, model: z.string().min(1) });

export const ipcInvoke = {
  'app.getVersion': { input: z.undefined(), output: z.string() },
  'runner.getStatus': { input: z.undefined(), output: z.object({ status: RunnerStatus }) },
  'secrets.getStatus': { input: z.undefined(), output: SecretStorageStatus },
  'connections.list': { input: z.undefined(), output: z.array(ConnectionSummary) },
  'connections.create': { input: ConnectionDraft, output: ConnectionSummary },
  'connections.update': {
    input: ById.extend({ patch: ConnectionPatch }),
    output: ConnectionSummary,
  },
  'connections.delete': { input: ById, output: z.void() },
  'connections.test': { input: ConnectionTarget, output: TestResult },
  'connections.listModels': { input: ConnectionTarget, output: z.array(ModelInfo) },
  'connections.detectBinary': { input: DetectBinaryInput, output: CliDetectResult },
  'agents.list': { input: z.undefined(), output: z.array(Agent) },
  'agents.create': { input: AgentDraft, output: Agent },
  'agents.update': { input: ById.extend({ patch: AgentPatch }), output: Agent },
  'agents.delete': { input: ById, output: z.void() },
  /** `name` is the copy's name (localized by the UI); defaults to "<name> (copy)". */
  'agents.duplicate': {
    input: ById.extend({ name: z.string().trim().min(1).optional() }),
    output: Agent,
  },
  'settings.get': { input: z.undefined(), output: AppSettings },
  'settings.update': { input: AppSettingsPatch, output: AppSettings },
  'conversations.list': { input: ConversationListInput, output: z.array(ConversationSummary) },
  'conversations.create': { input: z.object({ agentId: Id }), output: Conversation },
  'conversations.rename': {
    input: ById.extend({ title: z.string().trim().min(1).max(200) }),
    output: Conversation,
  },
  'conversations.archive': { input: ById.extend({ archived: z.boolean() }), output: Conversation },
  /** Marks every reply so far as read. */
  'conversations.markRead': { input: ById, output: z.void() },
  'messages.list': { input: MessageListInput, output: MessagePage },
  /**
   * Persists the user message and starts a run. Rejects before persisting
   * anything with conversation_busy, connection_disabled, model_required or
   * secret_missing. Run failures arrive later as an `error` message.
   */
  'messages.send': { input: ByConversation.extend({ content: UserContent }), output: z.void() },
  /** Cancels the conversation's run; a no-op when none is running. */
  'messages.cancel': { input: ByConversation, output: z.void() },
  /** Runs the last errored reply again, in the same message. */
  'messages.retry': { input: ByConversation, output: z.void() },
  /**
   * Stores a file for the composer and returns its block (a file source under
   * the attachment store). Rejects with attachment_too_large or
   * unsupported_attachment.
   */
  'attachments.add': { input: AttachmentInput, output: AttachmentBlock },
  /** Conversations by title and messages by content (full-text), best first. */
  'search.query': { input: SearchInput, output: SearchResult },
  /** Native folder picker; null when cancelled. */
  'dialogs.pickFolder': { input: z.undefined(), output: z.string().nullable() },
  'toolServers.list': { input: z.undefined(), output: z.array(ToolServer) },
  'toolServers.create': { input: ToolServerDraft, output: ToolServer },
  'toolServers.update': { input: ById.extend({ patch: ToolServerPatch }), output: ToolServer },
  /** Built-in servers cannot be deleted (invalid_request); disable them instead. */
  'toolServers.delete': { input: ById, output: z.void() },
  /** Starts the server in the runner and lists its tools (a saved server or unsaved settings). */
  'toolServers.test': { input: ToolServerTestTarget, output: z.array(ToolDef) },
  'googleDrive.getStatus': { input: z.undefined(), output: GoogleDriveStatus },
  'googleDrive.configure': { input: GoogleDriveConfigureInput, output: GoogleDriveStatus },
  /**
   * Opens Google's consent page in the browser and waits (up to 5 min) for the
   * loopback redirect. Rejects with oauth_not_configured, oauth_cancelled,
   * oauth_failed or timeout.
   */
  'googleDrive.connect': { input: z.undefined(), output: GoogleDriveStatus },
  /** Aborts a connect in progress (it then rejects with oauth_cancelled). */
  'googleDrive.cancelConnect': { input: z.undefined(), output: z.void() },
  /** Revokes the tokens at Google (best effort) and forgets them. Keeps the client. */
  'googleDrive.disconnect': { input: z.undefined(), output: GoogleDriveStatus },
  /** The user's answer to a pending tool call. */
  'approvals.decide': {
    input: ByConversation.extend({ toolUseId: z.string(), decision: ApprovalDecision }),
    output: z.void(),
  },
  /** Totals and the tables by connection, agent and model, for one window. */
  'usage.summary': { input: UsageRange, output: UsageSummary },
  /** One point per day on the viewer's calendar, days without runs included. */
  'usage.timeseries': { input: UsageRange, output: z.array(UsageBucket) },
  /** What one conversation has used so far (the right panel). */
  'usage.conversation': { input: ByConversation, output: UsageTotals },
  /** Writes a CSV through a native save dialog; null when cancelled. */
  'usage.export': { input: UsageExportInput, output: z.string().nullable() },
  /** Every model seen in the records, with the price in force for it. */
  'usage.prices': { input: z.undefined(), output: z.array(ModelPrice) },
  /** Corrects a model's price and reprices its records (never harness costs). */
  'usage.setPrice': { input: ByModel.extend({ prices: ModelPrices }), output: z.array(ModelPrice) },
  /** Drops the correction and reprices from the built-in table. */
  'usage.clearPrice': { input: ByModel, output: z.array(ModelPrice) },
} as const;

export type IpcInvokeChannel = keyof typeof ipcInvoke;

/** Invoke results cross IPC wrapped, so AppError codes survive serialization. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorShape };
/** What the renderer sends: fields with defaults may be omitted. */
export type IpcInput<C extends IpcInvokeChannel> = z.input<(typeof ipcInvoke)[C]['input']>;
/** What main handlers receive, after validation and defaults. */
export type IpcParsedInput<C extends IpcInvokeChannel> = z.output<(typeof ipcInvoke)[C]['input']>;
export type IpcOutput<C extends IpcInvokeChannel> = z.infer<(typeof ipcInvoke)[C]['output']>;

/** Per-conversation event revision: increases by one with every message event. */
const Rev = z.number().int().positive();
const LiveRef = { conversationId: Id, messageId: Id, rev: Rev };

/**
 * Main → renderer. Messages stream as `message.updated` snapshots (created,
 * reset for retry, final state) plus `message.delta` / `message.block`. All
 * three carry the conversation's `rev`, so a page fetched mid-stream lines up
 * with the events around it (ADR 0008).
 */
export const ipcEvents = {
  'runner.status': z.object({ status: RunnerStatus }),
  'conversation.updated': z.object({
    conversation: Conversation,
    pendingApproval: PendingApproval.nullable().default(null),
  }),
  'message.updated': z.object({ message: Message, rev: Rev }),
  'message.delta': z.object({ ...LiveRef, text: z.string() }),
  'message.block': z.object({ ...LiveRef, block: Block }),
} as const;

export type IpcEventChannel = keyof typeof ipcEvents;

export type IpcEventPayload<C extends IpcEventChannel> = z.infer<(typeof ipcEvents)[C]>;

/**
 * Shape of the API the preload exposes on `window.api`. `invoke` resolves to
 * the result envelope (never rejects for handler errors): custom Error
 * properties do not survive contextBridge, so LocalBackend unwraps it.
 */
export interface DesktopApi {
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    input: IpcInput<C>,
  ): Promise<IpcResult<IpcOutput<C>>>;
  on<C extends IpcEventChannel>(
    channel: C,
    handler: (payload: IpcEventPayload<C>) => void,
  ): () => void;
}
