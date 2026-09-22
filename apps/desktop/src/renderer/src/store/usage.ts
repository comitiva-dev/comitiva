import { createStore } from 'zustand/vanilla';
import type {
  ErrorCode,
  ModelPrice,
  ModelPrices,
  ProviderId,
  UsageBucket,
  UsageSummary,
  UsageTotals,
} from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';
import type { Async } from '../lib/async';
import { rangeOf, type Period } from '../lib/usage';

export interface UsageState {
  /** What the period selector has chosen. */
  period: Period;
  summary: Async<UsageSummary>;
  series: Async<UsageBucket[]>;
  prices: Async<ModelPrice[]>;
  /** Totals per conversation, for the right panel. Loaded on demand. */
  byConversation: Record<string, UsageTotals>;
  /** The last export: where the file went, or why it failed. */
  lastExport: Async<string | null>;
  /** Error from a background load, shown as a notice. */
  notice: ErrorCode | null;

  setPeriod(period: Period): Promise<void>;
  /** Loads the dashboard for the current period. */
  load(): Promise<void>;
  loadPrices(): Promise<void>;
  loadConversation(conversationId: string): Promise<void>;
  exportCsv(shape: 'records' | 'summary'): Promise<void>;
  /** Corrects a price; rejects so the form can show the error. */
  savePrice(provider: ProviderId, model: string, prices: ModelPrices): Promise<void>;
  clearPrice(provider: ProviderId, model: string): Promise<void>;
  dismissNotice(): void;
}

export type UsageStore = ReturnType<typeof createUsageStore>;

export function createUsageStore(backend: Backend) {
  return createStore<UsageState>()((set, get) => {
    const guarded = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    };

    /** The dashboard is two calls; one failing must not leave the other stale. */
    const load = async (): Promise<void> => {
      const range = rangeOf(get().period);
      set({ summary: { state: 'busy' }, series: { state: 'busy' } });
      const [summary, series] = await Promise.allSettled([
        backend.usage.summary(range),
        backend.usage.timeseries(range),
      ]);
      set({
        summary:
          summary.status === 'fulfilled'
            ? { state: 'done', value: summary.value }
            : { state: 'failed', code: errorCode(summary.reason) },
        series:
          series.status === 'fulfilled'
            ? { state: 'done', value: series.value }
            : { state: 'failed', code: errorCode(series.reason) },
      });
    };

    /** A price change recosts records, so the dashboard has to come back too. */
    const afterPrices = async (prices: ModelPrice[]): Promise<void> => {
      set({ prices: { state: 'done', value: prices } });
      await load();
    };

    return {
      period: { id: 'last30' },
      summary: { state: 'idle' },
      series: { state: 'idle' },
      prices: { state: 'idle' },
      byConversation: {},
      lastExport: { state: 'idle' },
      notice: null,

      setPeriod: async (period) => {
        set({ period });
        await load();
      },

      load,

      loadPrices: () =>
        guarded(async () => {
          set({ prices: { state: 'busy' } });
          set({ prices: { state: 'done', value: await backend.usage.prices() } });
        }),

      loadConversation: (conversationId) =>
        guarded(async () => {
          const totals = await backend.usage.conversation(conversationId);
          set((s) => ({ byConversation: { ...s.byConversation, [conversationId]: totals } }));
        }),

      exportCsv: async (shape) => {
        set({ lastExport: { state: 'busy' } });
        try {
          const path = await backend.usage.export({ ...rangeOf(get().period), shape });
          set({ lastExport: { state: 'done', value: path } });
        } catch (err) {
          set({ lastExport: { state: 'failed', code: errorCode(err) } });
        }
      },

      savePrice: async (provider, model, prices) => {
        await afterPrices(await backend.usage.setPrice(provider, model, prices));
      },

      clearPrice: async (provider, model) => {
        await afterPrices(await backend.usage.clearPrice(provider, model));
      },

      dismissNotice: () => set({ notice: null }),
    };
  });
}
