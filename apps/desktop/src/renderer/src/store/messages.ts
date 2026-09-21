import { createStore } from 'zustand/vanilla';
import { appendText, type ErrorCode, type Message } from '@comitiva/contract';
import { errorCode, type Backend, type BackendEvent, type MessageEvent } from '../backend/Backend';

export interface ConversationMessages {
  /** Ordered by seq. */
  items: Message[];
  status: 'loading' | 'ready' | 'failed';
  error: ErrorCode | null;
  hasMore: boolean;
  loadingOlder: boolean;
  /**
   * The conversation's event revision this state reflects (ADR 0008):
   * events at or below it are already included and are dropped.
   */
  rev: number;
  /** Events that arrive while the first page loads, replayed once it is in. */
  buffered: MessageEvent[];
}

export interface MessagesState {
  /** Only conversations that were opened; others ignore events (their page has them). */
  byConversation: Record<string, ConversationMessages>;
  /** Composer text per conversation, kept across switches. */
  drafts: Record<string, string>;
  /** A send in flight (the IPC call, not the run). */
  sending: Record<string, boolean>;
  /** Why the last send, cancel or retry was refused. */
  actionError: Record<string, ErrorCode | null>;

  /** Loads the latest page, unless it is loaded or loading (`force` reloads). */
  load(conversationId: string, opts?: { force?: boolean }): Promise<void>;
  loadOlder(conversationId: string): Promise<void>;
  setDraft(conversationId: string, text: string): void;
  /** Sends the draft; it is cleared only once the backend took it. */
  send(conversationId: string): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  retry(conversationId: string): Promise<void>;
  dismissError(conversationId: string): void;
  handleEvent(event: BackendEvent): void;
}

export type MessagesStore = ReturnType<typeof createMessagesStore>;

const empty = (): ConversationMessages => ({
  items: [],
  status: 'loading',
  error: null,
  hasMore: false,
  loadingOlder: false,
  rev: 0,
  buffered: [],
});

const isMessageEvent = (e: BackendEvent): e is MessageEvent =>
  e.type === 'message.updated' || e.type === 'message.delta' || e.type === 'message.block';

const conversationOf = (e: MessageEvent) =>
  e.type === 'message.updated' ? e.message.conversationId : e.conversationId;

/** Inserts or replaces a message, keeping seq order. */
function upsert(items: Message[], message: Message): Message[] {
  const i = items.findIndex((m) => m.id === message.id);
  if (i >= 0) return items.map((m, j) => (j === i ? message : m));
  const at = items.findIndex((m) => m.seq > message.seq);
  return at < 0 ? [...items, message] : [...items.slice(0, at), message, ...items.slice(at)];
}

/**
 * Applies one event to a loaded conversation. Only the affected message
 * object changes, so other rows keep their identity (and do not re-render).
 * Returns null when the event cannot be applied (a gap or an unknown
 * message): the caller reloads the page.
 */
function apply(state: ConversationMessages, e: MessageEvent): ConversationMessages | null {
  if (e.rev <= state.rev) return state; // already in the page
  if (e.rev !== state.rev + 1) return null; // an event went missing
  if (e.type === 'message.updated')
    return { ...state, rev: e.rev, items: upsert(state.items, e.message) };
  const target = state.items.find((m) => m.id === e.messageId);
  if (!target) return null;
  const content =
    e.type === 'message.delta' ? appendText(target.content, e.text) : [...target.content, e.block];
  return {
    ...state,
    rev: e.rev,
    items: state.items.map((m) => (m === target ? { ...m, content } : m)),
  };
}

export function createMessagesStore(backend: Backend) {
  return createStore<MessagesState>()((set, get) => {
    const patch = (id: string, fn: (c: ConversationMessages) => ConversationMessages) =>
      set((s) => {
        const current = s.byConversation[id];
        return current ? { byConversation: { ...s.byConversation, [id]: fn(current) } } : {};
      });

    const setError = (id: string, code: ErrorCode | null) =>
      set((s) => ({ actionError: { ...s.actionError, [id]: code } }));

    /** The latest load per conversation: an older one that resolves late is ignored. */
    const loads = new Map<string, number>();

    const act = async (id: string, fn: () => Promise<void>) => {
      setError(id, null);
      try {
        await fn();
      } catch (err) {
        setError(id, errorCode(err));
      }
    };

    return {
      byConversation: {},
      drafts: {},
      sending: {},
      actionError: {},

      async load(id, opts = {}) {
        const current = get().byConversation[id];
        if (current && current.status !== 'failed' && !opts.force) return;
        const token = (loads.get(id) ?? 0) + 1;
        loads.set(id, token);
        // Events that arrive from now on wait for the page (buffered); a reload keeps what is shown.
        set((s) => ({
          byConversation: {
            ...s.byConversation,
            [id]: { ...empty(), items: current?.items ?? [] },
          },
        }));
        try {
          const page = await backend.messages.list(id);
          if (loads.get(id) !== token) return;
          const { buffered } = get().byConversation[id] ?? empty();
          let next: ConversationMessages | null = {
            ...empty(),
            items: page.messages,
            hasMore: page.hasMore,
            rev: page.rev,
            status: 'ready',
          };
          for (const e of buffered) {
            next = apply(next, e);
            if (!next) return void get().load(id, { force: true });
          }
          set((s) => ({ byConversation: { ...s.byConversation, [id]: next! } }));
        } catch (err) {
          if (loads.get(id) !== token) return;
          patch(id, (c) => ({ ...c, status: 'failed', error: errorCode(err), buffered: [] }));
        }
      },

      async loadOlder(id) {
        const current = get().byConversation[id];
        if (!current || current.status !== 'ready' || !current.hasMore || current.loadingOlder)
          return;
        patch(id, (c) => ({ ...c, loadingOlder: true }));
        try {
          const oldest = current.items[0]?.seq;
          const page = await backend.messages.list(
            id,
            oldest !== undefined ? { beforeSeq: oldest } : {},
          );
          patch(id, (c) => {
            const known = new Set(c.items.map((m) => m.id));
            const older = page.messages.filter((m) => !known.has(m.id));
            return {
              ...c,
              items: [...older, ...c.items],
              hasMore: page.hasMore,
              loadingOlder: false,
            };
          });
        } catch {
          patch(id, (c) => ({ ...c, loadingOlder: false }));
        }
      },

      setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),

      async send(id) {
        const text = (get().drafts[id] ?? '').trim();
        if (!text || get().sending[id]) return;
        set((s) => ({ sending: { ...s.sending, [id]: true } }));
        await act(id, async () => {
          await backend.messages.send(id, [{ type: 'text', text }]);
          set((s) => ({ drafts: { ...s.drafts, [id]: '' } }));
        });
        set((s) => ({ sending: { ...s.sending, [id]: false } }));
      },

      cancel: (id) => act(id, () => backend.messages.cancel(id)),
      retry: (id) => act(id, () => backend.messages.retry(id)),
      dismissError: (id) => setError(id, null),

      handleEvent(event) {
        if (!isMessageEvent(event)) return;
        const id = conversationOf(event);
        const current = get().byConversation[id];
        if (!current) return;
        if (current.status === 'loading') {
          patch(id, (c) => ({ ...c, buffered: [...c.buffered, event] }));
          return;
        }
        if (current.status !== 'ready') return;
        const next = apply(current, event);
        if (!next) void get().load(id, { force: true });
        else if (next !== current) patch(id, () => next);
      },
    };
  });
}
