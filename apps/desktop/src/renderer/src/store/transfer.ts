import { createStore } from 'zustand/vanilla';
import type { ErrorCode, ImportReport } from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';

export interface TransferState {
  busy: 'export' | 'import' | null;
  /** Where the last export was saved (a short confirmation). */
  saved: string | null;
  /** The last import's result, shown until dismissed. */
  report: ImportReport | null;
  notice: ErrorCode | null;

  exportConversation(conversationId: string): Promise<void>;
  /** All agents, or those listed. */
  exportAgents(agentIds?: string[]): Promise<void>;
  importBundle(): Promise<void>;
  dismiss(): void;
}

export type TransferStore = ReturnType<typeof createTransferStore>;

/**
 * Exports (a conversation as Markdown, agents as a bundle) and imports. A
 * cancelled dialog is not an error. After an import, `afterImport` reloads
 * what the bundle added (agents, connections, tool servers).
 */
export function createTransferStore(
  backend: Backend,
  opts: { afterImport?: () => Promise<void> | void } = {},
) {
  return createStore<TransferState>()((set, get) => {
    const run = async <T>(kind: 'export' | 'import', fn: () => Promise<T>): Promise<T | null> => {
      if (get().busy) return null;
      set({ busy: kind, notice: null, saved: null });
      try {
        return await fn();
      } catch (err) {
        set({ notice: errorCode(err) });
        return null;
      } finally {
        set({ busy: null });
      }
    };

    return {
      busy: null,
      saved: null,
      report: null,
      notice: null,

      async exportConversation(id) {
        const path = await run('export', () => backend.conversations.exportMarkdown(id));
        if (path) set({ saved: path });
      },

      async exportAgents(agentIds) {
        const path = await run('export', () => backend.bundle.export(agentIds));
        if (path) set({ saved: path });
      },

      async importBundle() {
        const report = await run('import', () => backend.bundle.import());
        if (!report) return;
        set({ report });
        await opts.afterImport?.();
      },

      dismiss: () => set({ saved: null, report: null, notice: null }),
    };
  });
}
