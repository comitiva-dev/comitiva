import { createStore } from 'zustand/vanilla';
import type { ErrorCode, RunnerStatus, SpikeEvent } from '@comitiva/contract';
import { errorCode, type Backend, type BackendEvent } from '../backend/Backend';
import { afterNextPaint, preciseNow } from '../lib/paint';
import { latencyStats, type LatencyStats } from '../lib/stats';

export type PaneId = 'a' | 'b';
export const PANES: PaneId[] = ['a', 'b'];
const conversationIdOf = (pane: PaneId) => `spike-${pane}`;
const paneOf = (conversationId: string): PaneId | null =>
  conversationId === 'spike-a' ? 'a' : conversationId === 'spike-b' ? 'b' : null;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

export interface PaneState {
  input: string;
  output: string;
  status: 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';
  usage: Usage | null;
  errorCode: ErrorCode | null;
  /** Runner-event → paint samples for the current run (ms). */
  samples: number[];
  latency: LatencyStats | null;
}

export interface SpikeState {
  version: string;
  runnerStatus: RunnerStatus;
  hasApiKey: boolean;
  weakSecretStorage: boolean;
  apiKeyDraft: string;
  keyStatus: 'idle' | 'saving' | 'saved' | 'testing' | 'ok' | 'failed';
  keyError: ErrorCode | null;
  model: string;
  panes: Record<PaneId, PaneState>;

  init(): Promise<void>;
  setApiKeyDraft(value: string): void;
  saveApiKey(): Promise<void>;
  testApiKey(): Promise<void>;
  setModel(value: string): void;
  setInput(pane: PaneId, value: string): void;
  send(pane: PaneId): Promise<void>;
  cancel(pane: PaneId): Promise<void>;
  reset(pane: PaneId): Promise<void>;
  handleEvent(event: BackendEvent): void;
}

const emptyPane = (): PaneState => ({
  input: '',
  output: '',
  status: 'idle',
  usage: null,
  errorCode: null,
  samples: [],
  latency: null,
});

export interface SpikeStoreOptions {
  /** Injected for tests; defaults to measuring after the next paint. */
  afterPaint?: (cb: () => void) => void;
  now?: () => number;
}

export function createSpikeStore(backend: Backend, opts: SpikeStoreOptions = {}) {
  const afterPaint = opts.afterPaint ?? afterNextPaint;
  const now = opts.now ?? preciseNow;

  return createStore<SpikeState>()((set, get) => {
    const patchPane = (
      pane: PaneId,
      patch: Partial<PaneState> | ((p: PaneState) => Partial<PaneState>),
    ) =>
      set((s) => {
        const current = s.panes[pane];
        const next = typeof patch === 'function' ? patch(current) : patch;
        return { panes: { ...s.panes, [pane]: { ...current, ...next } } };
      });

    const finishRun = (pane: PaneId) => {
      // Queued after any pending paint measurements for this run.
      afterPaint(() => {
        const samples = get().panes[pane].samples;
        patchPane(pane, { latency: latencyStats(samples) });
        if (samples.length > 0)
          void backend.spike.reportLatency(conversationIdOf(pane), samples).catch(() => {});
      });
    };

    const applySpikeEvent = (e: SpikeEvent) => {
      const pane = paneOf(e.conversationId);
      if (!pane) return;
      switch (e.kind) {
        case 'delta': {
          patchPane(pane, (p) => ({ output: p.output + e.text }));
          const emittedAt = e.runnerTs;
          if (emittedAt !== undefined) {
            afterPaint(() => {
              const sample = now() - emittedAt;
              patchPane(pane, (p) => ({ samples: [...p.samples, sample] }));
            });
          }
          break;
        }
        case 'usage':
          patchPane(pane, {
            usage: {
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              cacheReadTokens: e.cacheReadTokens,
              cacheWriteTokens: e.cacheWriteTokens,
            },
          });
          break;
        case 'done':
          patchPane(pane, { status: e.stopReason === 'cancelled' ? 'cancelled' : 'done' });
          finishRun(pane);
          break;
        case 'error':
          patchPane(pane, { status: 'error', errorCode: e.code });
          finishRun(pane);
          break;
      }
    };

    return {
      version: '',
      runnerStatus: 'starting',
      hasApiKey: false,
      weakSecretStorage: false,
      apiKeyDraft: '',
      keyStatus: 'idle',
      keyError: null,
      model: '',
      panes: { a: emptyPane(), b: emptyPane() },

      async init() {
        const [version, runnerStatus, state] = await Promise.all([
          backend.app.getVersion(),
          backend.runner.getStatus(),
          backend.spike.getState(),
        ]);
        set({
          version,
          runnerStatus,
          hasApiKey: state.hasApiKey,
          weakSecretStorage: state.weakSecretStorage,
          model: get().model || state.defaultModel,
        });
      },

      setApiKeyDraft(value) {
        set({ apiKeyDraft: value });
      },

      async saveApiKey() {
        const key = get().apiKeyDraft.trim();
        if (!key) return;
        set({ keyStatus: 'saving', keyError: null });
        try {
          await backend.spike.saveApiKey(key);
          // The key leaves the renderer once saved; only "saved" is kept.
          set({ keyStatus: 'saved', hasApiKey: true, apiKeyDraft: '' });
        } catch (err) {
          set({ keyStatus: 'failed', keyError: errorCode(err) });
        }
      },

      async testApiKey() {
        set({ keyStatus: 'testing', keyError: null });
        try {
          const r = await backend.spike.testApiKey();
          set(r.ok ? { keyStatus: 'ok' } : { keyStatus: 'failed', keyError: r.error.code });
        } catch (err) {
          set({ keyStatus: 'failed', keyError: errorCode(err) });
        }
      },

      setModel(value) {
        set({ model: value });
      },

      setInput(pane, value) {
        patchPane(pane, { input: value });
      },

      async send(pane) {
        const { input, status } = get().panes[pane];
        if (!input.trim() || status === 'streaming') return;
        patchPane(pane, { ...emptyPane(), input: '', status: 'streaming' });
        try {
          await backend.spike.send(conversationIdOf(pane), input, get().model);
        } catch (err) {
          patchPane(pane, { status: 'error', errorCode: errorCode(err), input });
        }
      },

      async cancel(pane) {
        await backend.spike.cancel(conversationIdOf(pane));
      },

      async reset(pane) {
        await backend.spike.reset(conversationIdOf(pane));
        patchPane(pane, emptyPane());
      },

      handleEvent(event) {
        if (event.type === 'runner.status') set({ runnerStatus: event.status });
        else applySpikeEvent(event.event);
      },
    };
  });
}

export type SpikeStore = ReturnType<typeof createSpikeStore>;
