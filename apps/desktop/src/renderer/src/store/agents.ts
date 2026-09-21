import { createStore } from 'zustand/vanilla';
import type {
  Agent,
  AgentDraft,
  AgentPatch,
  AppSettings,
  ErrorCode,
  ModelInfo,
} from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';
import type { AgentFormState } from '../lib/agentForm';
import type { Async } from '../lib/async';

export type AgentEditor =
  | { mode: 'closed' }
  | { mode: 'create'; prefill?: Partial<AgentFormState> }
  | { mode: 'edit'; id: string };

export interface AgentsState {
  items: Agent[];
  loaded: boolean;
  selectedId: string | null;
  editor: AgentEditor;
  /** Id awaiting delete confirmation. */
  confirmDelete: string | null;
  /** Error from the last list/duplicate/delete/sample action, shown as a notice. */
  notice: ErrorCode | null;
  /** Models per connection, fetched once per session (retry forces a new fetch). */
  models: Record<string, Async<ModelInfo[]>>;
  /** Null until loaded. */
  settings: AppSettings | null;

  load(): Promise<void>;
  select(id: string | null): void;
  openCreate(prefill?: Partial<AgentFormState>): void;
  openEdit(id: string): void;
  closeEditor(): void;
  /** Saves the editor's form; rejects with the backend error so the form can show it. */
  save(input: { draft: AgentDraft } | { id: string; patch: AgentPatch }): Promise<void>;
  /** Inline role edit from the panel; rejects so the editor can stay open. */
  updateRole(id: string, role: string): Promise<void>;
  duplicate(id: string, name: string): Promise<void>;
  askDelete(id: string): void;
  cancelDelete(): void;
  confirmDeletion(): Promise<void>;
  dismissNotice(): void;
  fetchModels(connectionId: string, opts?: { force?: boolean }): Promise<void>;
  /**
   * The first-run offer. Creates the sample agent on the given connection;
   * when that connection needs a model it lacks, opens the prefilled form
   * instead. Either way the offer is not shown again.
   */
  createSample(sample: AgentDraft): Promise<void>;
  dismissSample(): Promise<void>;
}

export type AgentsStore = ReturnType<typeof createAgentsStore>;

export function createAgentsStore(backend: Backend) {
  return createStore<AgentsState>()((set, get) => {
    const replace = (agent: Agent) =>
      set((s) => ({
        items: s.items.some((a) => a.id === agent.id)
          ? s.items.map((a) => (a.id === agent.id ? agent : a))
          : [...s.items, agent],
      }));

    const guarded = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    };

    const offerDone = async () => {
      set({ settings: await backend.settings.update({ sampleAgentOffer: 'done' }) });
    };

    return {
      items: [],
      loaded: false,
      selectedId: null,
      editor: { mode: 'closed' },
      confirmDelete: null,
      notice: null,
      models: {},
      settings: null,

      load: () =>
        guarded(async () => {
          const [items, settings] = await Promise.all([
            backend.agents.list(),
            backend.settings.get(),
          ]);
          set((s) => ({
            items,
            settings,
            loaded: true,
            selectedId: items.some((a) => a.id === s.selectedId) ? s.selectedId : null,
          }));
        }),

      select: (id) => set({ selectedId: id }),

      openCreate: (prefill) =>
        set({ editor: prefill ? { mode: 'create', prefill } : { mode: 'create' } }),
      openEdit: (id) => set({ editor: { mode: 'edit', id } }),
      closeEditor: () => set({ editor: { mode: 'closed' } }),

      async save(input) {
        const agent =
          'draft' in input
            ? await backend.agents.create(input.draft)
            : await backend.agents.update(input.id, input.patch);
        replace(agent);
        set({ editor: { mode: 'closed' }, selectedId: agent.id });
      },

      async updateRole(id, role) {
        replace(await backend.agents.update(id, { role }));
      },

      duplicate: (id, name) =>
        guarded(async () => {
          const copy = await backend.agents.duplicate(id, name);
          replace(copy);
          set({ selectedId: copy.id });
        }),

      askDelete: (id) => set({ confirmDelete: id }),
      cancelDelete: () => set({ confirmDelete: null }),

      async confirmDeletion() {
        const id = get().confirmDelete;
        if (!id) return;
        set({ confirmDelete: null });
        await guarded(async () => {
          await backend.agents.delete(id);
          set((s) => ({
            items: s.items.filter((a) => a.id !== id),
            selectedId: s.selectedId === id ? null : s.selectedId,
          }));
        });
      },

      dismissNotice: () => set({ notice: null }),

      async fetchModels(connectionId, opts = {}) {
        const current = get().models[connectionId];
        if (!opts.force && current && current.state !== 'failed' && current.state !== 'idle') {
          return;
        }
        const put = (value: Async<ModelInfo[]>) =>
          set((s) => ({ models: { ...s.models, [connectionId]: value } }));
        put({ state: 'busy' });
        try {
          put({ state: 'done', value: await backend.connections.listModels({ id: connectionId }) });
        } catch (err) {
          put({ state: 'failed', code: errorCode(err) });
        }
      },

      async createSample(sample) {
        await guarded(async () => {
          try {
            const agent = await backend.agents.create(sample);
            replace(agent);
            set({ selectedId: agent.id });
          } catch (err) {
            if (errorCode(err) !== 'model_required') throw err;
            get().openCreate({
              name: sample.name,
              role: sample.role ?? '',
              connectionId: sample.connectionId,
              color: sample.avatar.color,
              emoji: sample.avatar.emoji ?? '',
            });
          }
          await offerDone();
        });
      },

      dismissSample: () => guarded(offerDone),
    };
  });
}
