import { createStore } from 'zustand/vanilla';
import type {
  ErrorCode,
  ToolDef,
  ToolServer,
  ToolServerDraft,
  ToolServerPatch,
  ToolServerTestTarget,
} from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';
import type { Async } from '../lib/async';
import type { Editor } from './connections';

export interface ToolServersState {
  /** Built-ins first. */
  items: ToolServer[];
  loaded: boolean;
  /** Error from the last list/toggle/delete, shown as a notice. */
  notice: ErrorCode | null;
  /** The last "Test" per server: its tools, or why it failed. */
  tests: Record<string, Async<ToolDef[]>>;
  editor: Editor;
  confirmDelete: string | null;

  load(): Promise<void>;
  openCreate(): void;
  openEdit(id: string): void;
  closeEditor(): void;
  /** Saves the editor; rejects with the backend error so the form can show it. */
  save(input: { draft: ToolServerDraft } | { id: string; patch: ToolServerPatch }): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  test(id: string): Promise<void>;
  /** Tests unsaved form settings; resolves with the tools or rejects with the backend error. */
  probe(target: ToolServerTestTarget): Promise<ToolDef[]>;
  /** Forgets a server's last test (its account or settings changed). */
  clearTest(id: string): void;
  askDelete(id: string): void;
  cancelDelete(): void;
  confirmDeletion(): Promise<void>;
  dismissNotice(): void;
}

export type ToolServersStore = ReturnType<typeof createToolServersStore>;

/** The Tools screen: MCP servers, the built-in one included. */
export function createToolServersStore(backend: Backend) {
  return createStore<ToolServersState>()((set, get) => {
    const replace = (server: ToolServer) =>
      set((s) => ({
        items: s.items.some((i) => i.id === server.id)
          ? s.items.map((i) => (i.id === server.id ? server : i))
          : [...s.items, server],
        // A changed server's old test result no longer applies.
        tests: { ...s.tests, [server.id]: { state: 'idle' } },
      }));

    const guarded = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    };

    return {
      items: [],
      loaded: false,
      notice: null,
      tests: {},
      editor: { mode: 'closed' },
      confirmDelete: null,

      load: () =>
        guarded(async () => {
          set({ items: await backend.toolServers.list(), loaded: true });
        }),

      openCreate: () => set({ editor: { mode: 'create' } }),
      openEdit: (id) => set({ editor: { mode: 'edit', id } }),
      closeEditor: () => set({ editor: { mode: 'closed' } }),

      async save(input) {
        const server =
          'draft' in input
            ? await backend.toolServers.create(input.draft)
            : await backend.toolServers.update(input.id, input.patch);
        replace(server);
        set({ editor: { mode: 'closed' } });
      },

      setEnabled: (id, enabled) =>
        guarded(async () => {
          replace(await backend.toolServers.update(id, { enabled }));
        }),

      async test(id) {
        if (get().tests[id]?.state === 'busy') return;
        const mark = (value: Async<ToolDef[]>) =>
          set((s) => ({ tests: { ...s.tests, [id]: value } }));
        mark({ state: 'busy' });
        try {
          mark({ state: 'done', value: await backend.toolServers.test({ id }) });
        } catch (err) {
          mark({ state: 'failed', code: errorCode(err) });
        }
      },

      probe: (target) => backend.toolServers.test(target),

      clearTest: (id) => set((s) => ({ tests: { ...s.tests, [id]: { state: 'idle' } } })),

      askDelete: (id) => set({ confirmDelete: id }),
      cancelDelete: () => set({ confirmDelete: null }),

      confirmDeletion: () =>
        guarded(async () => {
          const id = get().confirmDelete;
          set({ confirmDelete: null });
          if (!id) return;
          await backend.toolServers.delete(id);
          set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
        }),

      dismissNotice: () => set({ notice: null }),
    };
  });
}
