import type { Agent, MessageRole, SearchResult, SearchSnippet } from '@comitiva/contract';

export type SwitcherItem =
  | { kind: 'agent'; key: string; agentId: string; name: string }
  | {
      kind: 'conversation';
      key: string;
      agentId: string;
      conversationId: string;
      title: string | null;
    }
  | {
      kind: 'message';
      key: string;
      agentId: string;
      conversationId: string;
      seq: number;
      role: MessageRole;
      title: string | null;
      snippet: SearchSnippet;
    };

export interface RecentConversation {
  id: string;
  agentId: string;
  title: string | null;
  lastActivityAt: string;
}

/** Lower case without diacritics, so "joao" matches "João". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const RECENT = 8;

/**
 * What the quick switcher lists. With no query: every agent, then the most
 * recent conversations. With one: agents whose name matches, then the
 * conversations and messages the backend found.
 */
export function switcherItems(
  query: string,
  agents: readonly Pick<Agent, 'id' | 'name'>[],
  recent: readonly RecentConversation[],
  result: SearchResult | null,
): SwitcherItem[] {
  const q = fold(query.trim());
  const agentItems: SwitcherItem[] = agents
    .filter((a) => q === '' || fold(a.name).includes(q))
    .map((a) => ({ kind: 'agent', key: `a:${a.id}`, agentId: a.id, name: a.name }));
  if (q === '') {
    const conversations = [...recent]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .slice(0, RECENT)
      .map((c): SwitcherItem => ({
        kind: 'conversation',
        key: `c:${c.id}`,
        agentId: c.agentId,
        conversationId: c.id,
        title: c.title,
      }));
    return [...agentItems, ...conversations];
  }
  const conversations: SwitcherItem[] = (result?.conversations ?? []).map((c) => ({
    kind: 'conversation',
    key: `c:${c.conversationId}`,
    agentId: c.agentId,
    conversationId: c.conversationId,
    title: c.title,
  }));
  const messages: SwitcherItem[] = (result?.messages ?? []).map((m) => ({
    kind: 'message',
    key: `m:${m.messageId}`,
    agentId: m.agentId,
    conversationId: m.conversationId,
    seq: m.seq,
    role: m.role,
    title: m.conversationTitle,
    snippet: m.snippet,
  }));
  return [...agentItems, ...conversations, ...messages];
}

/** The next highlighted row, wrapping at both ends. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((current + delta) % length) + length) % length;
}
