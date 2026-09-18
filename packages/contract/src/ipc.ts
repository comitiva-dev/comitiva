import { z } from 'zod';
import { AppErrorShape, ErrorCode } from './errors.js';
import { StopReason } from './runner-protocol.js';

export { ipcEventChannels, ipcInvokeChannels } from './ipc-channels.js';

/**
 * Desktop IPC contract: renderer ⇄ main. Every invoke channel has an input and
 * an output schema; main validates inputs before calling services.
 *
 * `spike.*` channels are temporary (Phase 0) and will be replaced by
 * connections/conversations/messages channels in Phases 1 and 4.
 */

export const RunnerStatus = z.enum(['starting', 'ready', 'restarting', 'stopped']);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

const ConversationRef = z.object({ conversationId: z.string().min(1) });

export const ipcInvoke = {
  'app.getVersion': { input: z.undefined(), output: z.string() },
  'runner.getStatus': { input: z.undefined(), output: z.object({ status: RunnerStatus }) },
  'spike.getState': {
    input: z.undefined(),
    output: z.object({
      hasApiKey: z.boolean(),
      defaultModel: z.string(),
      /** True when the OS offers no real keychain (Linux `basic_text`): secrets are only obfuscated. */
      weakSecretStorage: z.boolean(),
    }),
  },
  'spike.saveApiKey': { input: z.object({ apiKey: z.string().min(1) }), output: z.void() },
  'spike.testApiKey': {
    input: z.undefined(),
    output: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), latencyMs: z.number() }),
      z.object({ ok: z.literal(false), error: AppErrorShape }),
    ]),
  },
  'spike.send': {
    input: ConversationRef.extend({ text: z.string().min(1), model: z.string().min(1) }),
    output: z.void(),
  },
  'spike.cancel': { input: ConversationRef, output: z.void() },
  'spike.reset': { input: ConversationRef, output: z.void() },
  'spike.reportLatency': {
    input: ConversationRef.extend({ samplesMs: z.array(z.number()) }),
    output: z.void(),
  },
} as const;

export type IpcInvokeChannel = keyof typeof ipcInvoke;

/** Invoke results cross IPC wrapped, so AppError codes survive serialization. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorShape };
export type IpcInput<C extends IpcInvokeChannel> = z.infer<(typeof ipcInvoke)[C]['input']>;
export type IpcOutput<C extends IpcInvokeChannel> = z.infer<(typeof ipcInvoke)[C]['output']>;

export const SpikeEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delta'),
    conversationId: z.string(),
    text: z.string(),
    /** Runner emission time of the oldest delta in this batch (epoch ms). */
    runnerTs: z.number().optional(),
  }),
  z.object({
    kind: z.literal('usage'),
    conversationId: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  }),
  z.object({ kind: z.literal('done'), conversationId: z.string(), stopReason: StopReason }),
  z.object({
    kind: z.literal('error'),
    conversationId: z.string(),
    code: ErrorCode,
    retryable: z.boolean(),
  }),
]);
export type SpikeEvent = z.infer<typeof SpikeEvent>;

export const ipcEvents = {
  'spike.event': SpikeEvent,
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
