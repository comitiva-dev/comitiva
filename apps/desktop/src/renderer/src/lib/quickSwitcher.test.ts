import { describe, expect, it } from 'vitest';
import { fold, moveSelection, switcherItems } from './quickSwitcher';

const agents = [
  { id: 'a1', name: 'João Researcher' },
  { id: 'a2', name: 'Writer' },
];
const recent = Array.from({ length: 10 }, (_, i) => ({
  id: `c${i}`,
  agentId: 'a1',
  title: `Conv ${i}`,
  lastActivityAt: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
}));

describe('quick switcher', () => {
  it('folds case and accents', () => {
    expect(fold('João ÉCOLE')).toBe('joao ecole');
  });

  it('lists agents and the eight most recent conversations with no query', () => {
    const items = switcherItems('', agents, recent, null);
    expect(items.filter((i) => i.kind === 'agent')).toHaveLength(2);
    const convs = items.filter((i) => i.kind === 'conversation');
    expect(convs).toHaveLength(8);
    expect(convs[0]).toMatchObject({ conversationId: 'c9' });
  });

  it('matches agents locally and lists what the backend found', () => {
    const items = switcherItems('joao', agents, recent, {
      conversations: [
        {
          conversationId: 'c1',
          agentId: 'a1',
          title: 'Joao notes',
          lastActivityAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      messages: [
        {
          conversationId: 'c2',
          agentId: 'a2',
          messageId: 'm1',
          seq: 4,
          role: 'assistant',
          createdAt: '2026-09-01T00:00:00.000Z',
          conversationTitle: null,
          snippet: [{ text: 'joão', match: true }],
        },
      ],
    });
    expect(items.map((i) => i.key)).toEqual(['a:a1', 'c:c1', 'm:m1']);
  });

  it('wraps the selection', () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
