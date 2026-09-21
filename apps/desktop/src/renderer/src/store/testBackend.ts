import { vi } from 'vitest';
import type { Agent, AgentDraft, AppSettings, ConnectionSummary } from '@comitiva/contract';
import type { Backend } from '../backend/Backend';

export const summary = (
  id: string,
  overrides: Partial<ConnectionSummary> = {},
): ConnectionSummary => ({
  connection: {
    id,
    name: `Conn ${id}`,
    kind: 'api',
    provider: 'anthropic',
    config: {},
    secretRef: `connection:${id}`,
    enabled: true,
    createdAt: '2026-09-18T12:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
  },
  hasSecret: true,
  lastTest: null,
  ...overrides,
});

export const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  name: `Agent ${id}`,
  avatar: { color: 'indigo' },
  connectionId: 'c1',
  model: null,
  role: '',
  params: {},
  toolServerIds: [],
  roots: [],
  permissionPolicy: 'ask',
  fallbackConnectionIds: [],
  tags: [],
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
  ...overrides,
});

/** A Backend whose methods are vi.fn()s with sensible defaults. */
export function fakeBackend() {
  const backend = {
    app: { getVersion: vi.fn(async () => '0.1.0') },
    runner: { getStatus: vi.fn(async () => 'ready' as const) },
    secrets: { getStatus: vi.fn(async () => ({ available: true, weak: false })) },
    connections: {
      list: vi.fn(async (): Promise<ConnectionSummary[]> => []),
      create: vi.fn(async () => summary('new')),
      update: vi.fn(async (id: string) => summary(id)),
      delete: vi.fn(async () => {}),
      test: vi.fn(async () => ({ ok: true as const, latencyMs: 5 })),
      listModels: vi.fn(async () => [{ id: 'm1' }]),
      detectBinary: vi.fn(async () => ({ path: '/usr/local/bin/claude', version: '9.9.9' })),
    },
    agents: {
      list: vi.fn(async (): Promise<Agent[]> => []),
      create: vi.fn(async (draft: AgentDraft) => agent('new', { name: draft.name })),
      update: vi.fn(async (id: string) => agent(id)),
      delete: vi.fn(async () => {}),
      duplicate: vi.fn(async (_id: string, name?: string) =>
        agent('copy', { name: name ?? 'copy' }),
      ),
    },
    settings: {
      get: vi.fn(async (): Promise<AppSettings> => ({ sampleAgentOffer: 'pending' })),
      update: vi.fn(async (): Promise<AppSettings> => ({ sampleAgentOffer: 'done' })),
    },
    dialogs: { pickFolder: vi.fn(async (): Promise<string | null> => '/home/me/work') },
    onEvent: vi.fn(() => () => {}),
  } satisfies Backend;
  return backend;
}
