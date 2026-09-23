import { createStore } from 'zustand/vanilla';
import type { ErrorCode, SearchResult } from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';

export interface UiState {
  quickSwitcherOpen: boolean;
  shortcutsOpen: boolean;
  /** Bumped to open the composer's file picker (the attach shortcut). */
  attachRequest: number;
  /** The quick switcher's search: what was asked, and what came back for it. */
  search: {
    query: string;
    result: SearchResult | null;
    status: 'idle' | 'loading' | 'ready' | 'failed';
    error: ErrorCode | null;
  };

  openQuickSwitcher(): void;
  closeQuickSwitcher(): void;
  setShortcutsOpen(open: boolean): void;
  toggleQuickSwitcher(): void;
  requestAttach(): void;
  /** Searches messages and conversation titles; a slower, older answer is dropped. */
  runSearch(query: string): Promise<void>;
}

export type UiStore = ReturnType<typeof createUiStore>;

const idle = { query: '', result: null, status: 'idle', error: null } as const;

/** Overlays (quick switcher, shortcuts) and the switcher's search. */
export function createUiStore(backend: Backend) {
  return createStore<UiState>()((set, get) => {
    let latest = 0;
    return {
      quickSwitcherOpen: false,
      shortcutsOpen: false,
      attachRequest: 0,
      search: idle,

      openQuickSwitcher: () => set({ quickSwitcherOpen: true, shortcutsOpen: false, search: idle }),
      closeQuickSwitcher: () => {
        latest += 1;
        set({ quickSwitcherOpen: false, search: idle });
      },
      setShortcutsOpen: (open) =>
        set({ shortcutsOpen: open, ...(open ? { quickSwitcherOpen: false } : {}) }),

      toggleQuickSwitcher() {
        if (get().quickSwitcherOpen) get().closeQuickSwitcher();
        else get().openQuickSwitcher();
      },
      requestAttach: () => set((s) => ({ attachRequest: s.attachRequest + 1 })),

      async runSearch(query) {
        const token = ++latest;
        const q = query.trim();
        if (q === '') return set({ search: idle });
        set((s) => ({ search: { ...s.search, query: q, status: 'loading', error: null } }));
        try {
          const result = await backend.search.query({ query: q, limit: 20 });
          if (token === latest) set({ search: { query: q, result, status: 'ready', error: null } });
        } catch (err) {
          if (token === latest)
            set({ search: { query: q, result: null, status: 'failed', error: errorCode(err) } });
        }
      },
    };
  });
}
