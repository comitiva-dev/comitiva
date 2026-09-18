import type { Agent, Connection, Message } from '@comitiva/contract';

const now = '2026-01-01T00:00:00.000Z';

export function anthropicConnection(
  baseUrl?: string,
): Extract<Connection, { provider: 'anthropic' }> {
  return {
    id: 'conn-anthropic',
    name: 'Anthropic',
    kind: 'api',
    provider: 'anthropic',
    config: { defaultModel: 'claude-haiku-4-5', ...(baseUrl ? { baseUrl } : {}) },
    secretRef: 'connection:conn-anthropic',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function testAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Tester',
    avatar: '🧪',
    connectionId: 'conn-anthropic',
    model: 'claude-haiku-4-5',
    role: '',
    params: {},
    toolServerIds: [],
    roots: [],
    permissionPolicy: 'ask',
    fallbackConnectionIds: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function userText(conversationId: string, text: string, seq = 0): Message {
  return {
    id: `msg-${conversationId}-${seq}`,
    conversationId,
    role: 'user',
    content: [{ type: 'text', text }],
    status: 'complete',
    seq,
    createdAt: now,
  };
}
