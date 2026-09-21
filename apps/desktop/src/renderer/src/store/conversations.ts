import { createStore } from 'zustand/vanilla';
import type {
  ApprovalDecision,
  Conversation,
  ErrorCode,
  PendingApproval,
} from '@comitiva/contract';
import { errorCode, type Backend, type BackendEvent } from '../backend/Backend';
import type { Async } from '../lib/async';

/** What the sidebar shows for an agent: awaiting approval wins, then running, then error. */
export type AgentStatus = 'idle' | 'running' | 'awaiting-approval' | 'error';

export interface ConversationsState {
  byId: Record<string, Conversation>;
  /** Non-archived conversation ids per agent, newest activity first. */
  idsByAgent: Record<string, string[]>;
  /** Archived ids per agent, among those loaded ("Show archived") or archived this session. */
  archivedIdsByAgent: Record<string, string[]>;
  archivedLoad: Record<string, Async<true>>;
  /** Open conversation per agent; coming back to an agent reopens it. */
  selectedByAgent: Record<string, string | null>;
  /** The conversation on screen, if any: its replies are read as they arrive. */
  visibleId: string | null;
  /** Unread replies per conversation. */
  unread: Record<string, number>;
  /** The tool call each conversation waits on, if any (from main, with the status). */
  pending: Record<string, PendingApproval | null>;
  /** Conversations whose decision is on its way to main. */
  deciding: Record<string, boolean>;
  loaded: boolean;
  /** Error from the last list/create/rename/archive, shown as a notice. */
  notice: ErrorCode | null;

  /** Every non-archived conversation with its unread count (at boot). */
  load(): Promise<void>;
  loadArchived(agentId: string): Promise<void>;
  /** Creates and selects a conversation; null when it failed (see `notice`). */
  create(agentId: string): Promise<string | null>;
  select(agentId: string, id: string | null): void;
  /** Called by the chat view: what the user is looking at (null when nothing). */
  setVisible(id: string | null): void;
  rename(id: string, title: string): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
  /** After an agent is deleted: its conversations went with it (cascade), so drop them here too. */
  forgetAgent(agentId: string): void;
  /** Answers the pending tool call; errors show as a notice. */
  decide(conversationId: string, toolUseId: string, decision: ApprovalDecision): Promise<void>;
  dismissNotice(): void;
  handleEvent(event: BackendEvent): void;
}

export type ConversationsStore = ReturnType<typeof createConversationsStore>;

const newestFirst = (a: Conversation, b: Conversation) =>
  b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);

const FINAL = new Set(['complete', 'cancelled', 'error']);

export function createConversationsStore(backend: Backend) {
  return createStore<ConversationsState>()((set, get) => {
    /** Upserts conversations and rebuilds the id lists of the agents they belong to. */
    const put = (items: Conversation[]) =>
      set((s) => {
        const byId = { ...s.byId };
        const agents = new Set<string>();
        for (const c of items) {
          const previous = byId[c.id];
          if (previous) agents.add(previous.agentId);
          byId[c.id] = c;
          agents.add(c.agentId);
        }
        const idsByAgent = { ...s.idsByAgent };
        const archivedIdsByAgent = { ...s.archivedIdsByAgent };
        const all = Object.values(byId);
        for (const agentId of agents) {
          const own = all.filter((c) => c.agentId === agentId).sort(newestFirst);
          idsByAgent[agentId] = own.filter((c) => !c.archived).map((c) => c.id);
          archivedIdsByAgent[agentId] = own.filter((c) => c.archived).map((c) => c.id);
        }
        return { byId, idsByAgent, archivedIdsByAgent };
      });

    const guarded = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    };

    const markRead = (id: string) => {
      set((s) => ({ unread: { ...s.unread, [id]: 0 } }));
      backend.conversations.markRead(id).catch(() => {});
    };

    return {
      byId: {},
      idsByAgent: {},
      archivedIdsByAgent: {},
      archivedLoad: {},
      selectedByAgent: {},
      visibleId: null,
      unread: {},
      pending: {},
      deciding: {},
      loaded: false,
      notice: null,

      load: () =>
        guarded(async () => {
          const summaries = await backend.conversations.list();
          put(summaries.map((s) => s.conversation));
          set((s) => ({
            loaded: true,
            unread: {
              ...s.unread,
              ...Object.fromEntries(summaries.map((x) => [x.conversation.id, x.unread])),
            },
            pending: {
              ...s.pending,
              ...Object.fromEntries(summaries.map((x) => [x.conversation.id, x.pendingApproval])),
            },
          }));
        }),

      async loadArchived(agentId) {
        const current = get().archivedLoad[agentId];
        if (current?.state === 'busy' || current?.state === 'done') return;
        const mark = (value: Async<true>) =>
          set((s) => ({ archivedLoad: { ...s.archivedLoad, [agentId]: value } }));
        mark({ state: 'busy' });
        try {
          const summaries = await backend.conversations.list({ agentId, archived: true });
          put(summaries.map((s) => s.conversation));
          mark({ state: 'done', value: true });
        } catch (err) {
          mark({ state: 'failed', code: errorCode(err) });
        }
      },

      async create(agentId) {
        try {
          const conversation = await backend.conversations.create(agentId);
          put([conversation]);
          get().select(agentId, conversation.id);
          return conversation.id;
        } catch (err) {
          set({ notice: errorCode(err) });
          return null;
        }
      },

      select: (agentId, id) =>
        set((s) => ({ selectedByAgent: { ...s.selectedByAgent, [agentId]: id } })),

      setVisible(id) {
        set({ visibleId: id });
        if (id && (get().unread[id] ?? 0) > 0) markRead(id);
      },

      rename: (id, title) =>
        guarded(async () => {
          put([await backend.conversations.rename(id, title)]);
        }),

      archive: (id, archived) =>
        guarded(async () => {
          const conversation = await backend.conversations.archive(id, archived);
          put([conversation]);
          if (archived && get().selectedByAgent[conversation.agentId] === id) {
            get().select(conversation.agentId, null);
          }
        }),

      forgetAgent: (agentId) =>
        set((s) => {
          const gone = new Set([
            ...(s.idsByAgent[agentId] ?? []),
            ...(s.archivedIdsByAgent[agentId] ?? []),
          ]);
          const keep = <T>(r: Record<string, T>) =>
            Object.fromEntries(Object.entries(r).filter(([k]) => !gone.has(k) && k !== agentId));
          return {
            byId: keep(s.byId),
            unread: keep(s.unread),
            pending: keep(s.pending),
            idsByAgent: keep(s.idsByAgent),
            archivedIdsByAgent: keep(s.archivedIdsByAgent),
            archivedLoad: keep(s.archivedLoad),
            selectedByAgent: keep(s.selectedByAgent),
            visibleId: s.visibleId && gone.has(s.visibleId) ? null : s.visibleId,
          };
        }),

      async decide(conversationId, toolUseId, decision) {
        if (get().deciding[conversationId]) return;
        set((s) => ({ deciding: { ...s.deciding, [conversationId]: true } }));
        try {
          await backend.approvals.decide(conversationId, toolUseId, decision);
        } catch (err) {
          set({ notice: errorCode(err) });
        } finally {
          set((s) => ({ deciding: { ...s.deciding, [conversationId]: false } }));
        }
      },

      dismissNotice: () => set({ notice: null }),

      handleEvent(event) {
        if (event.type === 'conversation.updated') {
          put([event.conversation]);
          set((s) => ({
            pending: { ...s.pending, [event.conversation.id]: event.pendingApproval },
          }));
          return;
        }
        if (event.type !== 'message.updated') return;
        const { message } = event;
        if (message.role !== 'assistant' || !FINAL.has(message.status)) return;
        if (message.conversationId === get().visibleId) {
          markRead(message.conversationId);
        } else {
          set((s) => ({
            unread: {
              ...s.unread,
              [message.conversationId]: (s.unread[message.conversationId] ?? 0) + 1,
            },
          }));
        }
      },
    };
  });
}

// ---------------------------------------------------------------- selectors
// Primitives only, so components can select them without memoization.

export function agentStatus(s: ConversationsState, agentId: string): AgentStatus {
  let running = false;
  let error = false;
  for (const id of s.idsByAgent[agentId] ?? []) {
    const status = s.byId[id]?.status;
    if (status === 'awaiting-approval') return 'awaiting-approval';
    if (status === 'running') running = true;
    if (status === 'error') error = true;
  }
  return running ? 'running' : error ? 'error' : 'idle';
}

export function agentUnread(s: ConversationsState, agentId: string): number {
  return (s.idsByAgent[agentId] ?? []).reduce((n, id) => n + (s.unread[id] ?? 0), 0);
}

/** The "running set": derived from main's status, the one source of truth. */
export function isRunning(s: ConversationsState, id: string): boolean {
  const status = s.byId[id]?.status;
  return status === 'running' || status === 'awaiting-approval';
}
