import { createStore } from 'zustand/vanilla';
import type {
  ConnectionDraft,
  ConnectionPatch,
  ConnectionSummary,
  ConnectionTarget,
  ErrorCode,
  ModelInfo,
  TestResult,
} from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';

export type Editor = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; id: string };

export interface ConnectionsState {
  items: ConnectionSummary[];
  loaded: boolean;
  /** Error from the last list/update/delete, shown as a notice. */
  notice: ErrorCode | null;
  /** Ids with a test in flight from the list. */
  testing: Record<string, boolean>;
  editor: Editor;
  /** Id awaiting delete confirmation. */
  confirmDelete: string | null;

  load(): Promise<void>;
  openCreate(): void;
  openEdit(id: string): void;
  closeEditor(): void;
  /** Saves the editor's draft; rejects with the backend error so the form can show it. */
  save(input: { draft: ConnectionDraft } | { id: string; patch: ConnectionPatch }): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  test(id: string): Promise<void>;
  askDelete(id: string): void;
  cancelDelete(): void;
  confirmDeletion(): Promise<void>;
  dismissNotice(): void;
  /** For the form: test or list models for unsaved settings. */
  probe(target: ConnectionTarget): Promise<TestResult>;
  listModels(target: ConnectionTarget): Promise<ModelInfo[]>;
}

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;

export function createConnectionsStore(backend: Backend) {
  return createStore<ConnectionsState>()((set, get) => {
    const replace = (summary: ConnectionSummary) =>
      set((s) => ({
        items: s.items.some((i) => i.connection.id === summary.connection.id)
          ? s.items.map((i) => (i.connection.id === summary.connection.id ? summary : i))
          : [...s.items, summary],
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
      testing: {},
      editor: { mode: 'closed' },
      confirmDelete: null,

      load: () =>
        guarded(async () => {
          set({ items: await backend.connections.list(), loaded: true });
        }),

      openCreate: () => set({ editor: { mode: 'create' } }),
      openEdit: (id) => set({ editor: { mode: 'edit', id } }),
      closeEditor: () => set({ editor: { mode: 'closed' } }),

      async save(input) {
        const summary =
          'draft' in input
            ? await backend.connections.create(input.draft)
            : await backend.connections.update(input.id, input.patch);
        replace(summary);
        set({ editor: { mode: 'closed' } });
      },

      setEnabled: (id, enabled) =>
        guarded(async () => replace(await backend.connections.update(id, { enabled }))),

      async test(id) {
        set((s) => ({ testing: { ...s.testing, [id]: true } }));
        try {
          await backend.connections.test({ id });
          // The result is recorded by main; reload to show it with its timestamp.
          await get().load();
        } catch (err) {
          set({ notice: errorCode(err) });
        } finally {
          set((s) => ({ testing: { ...s.testing, [id]: false } }));
        }
      },

      askDelete: (id) => set({ confirmDelete: id }),
      cancelDelete: () => set({ confirmDelete: null }),

      async confirmDeletion() {
        const id = get().confirmDelete;
        if (!id) return;
        set({ confirmDelete: null });
        await guarded(async () => {
          await backend.connections.delete(id);
          set((s) => ({ items: s.items.filter((i) => i.connection.id !== id) }));
        });
      },

      dismissNotice: () => set({ notice: null }),

      probe: (target) => backend.connections.test(target),
      listModels: (target) => backend.connections.listModels(target),
    };
  });
}
