import { createStore } from 'zustand/vanilla';
import type { ErrorCode, Guideline, GuidelineDraft, GuidelinePatch } from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';
import type { Editor } from './connections';

/** What the last import or export did, shown until dismissed. */
export type GuidelinesFeedback =
  { kind: 'imported'; count: number } | { kind: 'exported'; path: string };

export interface GuidelinesState {
  /** In prompt order. */
  items: Guideline[];
  loaded: boolean;
  /** Error from the last list/move/delete/import/export, shown as a notice. */
  notice: ErrorCode | null;
  feedback: GuidelinesFeedback | null;
  editor: Editor;
  confirmDelete: string | null;

  load(): Promise<void>;
  openCreate(): void;
  openEdit(id: string): void;
  closeEditor(): void;
  /** Saves the editor; rejects with the backend error so the form can show it. */
  save(input: { draft: GuidelineDraft } | { id: string; patch: GuidelinePatch }): Promise<void>;
  /** Moves one up (-1) or down (+1) in the prompt order. */
  move(id: string, by: -1 | 1): Promise<void>;
  importFile(): Promise<void>;
  exportFile(): Promise<void>;
  askDelete(id: string): void;
  cancelDelete(): void;
  confirmDeletion(): Promise<void>;
  dismissNotice(): void;
}

export type GuidelinesStore = ReturnType<typeof createGuidelinesStore>;

/** The Guidelines screen, and the list the agent form offers. */
export function createGuidelinesStore(backend: Backend) {
  return createStore<GuidelinesState>()((set, get) => {
    const guarded = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        set({ notice: errorCode(err), feedback: null });
      }
    };

    return {
      items: [],
      loaded: false,
      notice: null,
      feedback: null,
      editor: { mode: 'closed' },
      confirmDelete: null,

      load: () =>
        guarded(async () => {
          set({ items: await backend.guidelines.list(), loaded: true });
        }),

      openCreate: () => set({ editor: { mode: 'create' } }),
      openEdit: (id) => set({ editor: { mode: 'edit', id } }),
      closeEditor: () => set({ editor: { mode: 'closed' } }),

      async save(input) {
        const saved =
          'draft' in input
            ? await backend.guidelines.create(input.draft)
            : await backend.guidelines.update(input.id, input.patch);
        set((s) => ({
          items: s.items.some((i) => i.id === saved.id)
            ? s.items.map((i) => (i.id === saved.id ? saved : i))
            : [...s.items, saved],
          editor: { mode: 'closed' },
        }));
      },

      move: (id, by) =>
        guarded(async () => {
          const index = get().items.findIndex((g) => g.id === id) + by;
          if (index < 0 || index >= get().items.length) return;
          set({ items: await backend.guidelines.move(id, index) });
        }),

      importFile: () =>
        guarded(async () => {
          const added = await backend.guidelines.import();
          if (!added) return;
          set((s) => ({
            items: [...s.items, ...added],
            notice: null,
            feedback: { kind: 'imported', count: added.length },
          }));
        }),

      exportFile: () =>
        guarded(async () => {
          const path = await backend.guidelines.export();
          if (path) set({ notice: null, feedback: { kind: 'exported', path } });
        }),

      askDelete: (id) => set({ confirmDelete: id }),
      cancelDelete: () => set({ confirmDelete: null }),

      confirmDeletion: () =>
        guarded(async () => {
          const id = get().confirmDelete;
          set({ confirmDelete: null });
          if (!id) return;
          await backend.guidelines.delete(id);
          // Positions closed the gap in main; the list is the source of truth.
          set({ items: await backend.guidelines.list() });
        }),

      dismissNotice: () => set({ notice: null, feedback: null }),
    };
  });
}
