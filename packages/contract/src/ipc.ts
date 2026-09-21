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
import { ErrorCode, type AppErrorShape } from './errors.js';
import {
  AnthropicConfig,
  CliConfig,
  CodexConfig,
  GoogleConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
} from './provider-config.js';
import { CliDetectResult, ModelInfo, TestResult } from './runner-protocol.js';

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
  /** Native folder picker; null when cancelled. */
  'dialogs.pickFolder': { input: z.undefined(), output: z.string().nullable() },
} as const;

export type IpcInvokeChannel = keyof typeof ipcInvoke;

/** Invoke results cross IPC wrapped, so AppError codes survive serialization. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorShape };
/** What the renderer sends: fields with defaults may be omitted. */
export type IpcInput<C extends IpcInvokeChannel> = z.input<(typeof ipcInvoke)[C]['input']>;
/** What main handlers receive, after validation and defaults. */
export type IpcParsedInput<C extends IpcInvokeChannel> = z.output<(typeof ipcInvoke)[C]['input']>;
export type IpcOutput<C extends IpcInvokeChannel> = z.infer<(typeof ipcInvoke)[C]['output']>;

export const ipcEvents = {
  'runner.status': z.object({ status: RunnerStatus }),
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
