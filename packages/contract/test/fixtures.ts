import type { Agent, Connection, Message } from '../src/index.js';

export const now = '2026-09-18T12:00:00.000Z';

export const anthropicConnection: Connection = {
  id: '01J00000000000000000000001',
  name: 'Anthropic',
  kind: 'api',
  provider: 'anthropic',
  config: { defaultModel: 'claude-haiku-4-5' },
  secretRef: 'connection:01J00000000000000000000001',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

export const agent: Agent = {
  id: '01J00000000000000000000002',
  name: 'Researcher',
  avatar: { color: 'indigo', emoji: '🔎' },
  connectionId: anthropicConnection.id,
  model: null,
  role: 'You research things.',
  params: {},
  toolServerIds: [],
  roots: [{ path: '/tmp/docs', mode: 'read' }],
  permissionPolicy: 'ask',
  fallbackConnectionIds: [],
  tags: [],
  createdAt: now,
  updatedAt: now,
};

export const userMessage: Message = {
  id: '01J00000000000000000000003',
  conversationId: '01J00000000000000000000004',
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
  status: 'complete',
  seq: 0,
  createdAt: now,
};
