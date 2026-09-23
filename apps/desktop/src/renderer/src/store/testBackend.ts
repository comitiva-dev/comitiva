import { vi } from 'vitest';
import type {
  Agent,
  AgentDraft,
  AppSettings,
  AttachmentBlock,
  AttachmentInput,
  SearchResult,
  ConnectionSummary,
  Conversation,
  ConversationSummary,
  ImportReport,
  GoogleDriveConfigureInput,
  GoogleDriveStatus,
  Message,
  MessagePage,
  ToolDef,
  ToolServer,
  ToolServerDraft,
  ModelPrice,
  ModelPrices,
  ProviderId,
  UsageBucket,
  UsageRange,
  UsageSummary,
  UsageSummaryRow,
  UsageTotals,
} from '@comitiva/contract';
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

const at = '2026-09-21T12:00:00.000Z';

export const conversation = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  id,
  agentId: 'a1',
  title: null,
  status: 'idle',
  harnessSessionId: null,
  archived: false,
  lastActivityAt: at,
  createdAt: at,
  ...overrides,
});

export const toolServer = (id: string, overrides: Partial<ToolServer> = {}): ToolServer => ({
  id,
  name: `Server ${id}`,
  transport: 'stdio',
  command: 'npx',
  args: [],
  env: {},
  url: null,
  headers: {},
  builtin: false,
  enabled: true,
  createdAt: at,
  ...overrides,
});

export const filesystemServer = (overrides: Partial<ToolServer> = {}) =>
  toolServer('filesystem', { name: 'Files', command: null, builtin: true, ...overrides });

export const googleDriveServer = (overrides: Partial<ToolServer> = {}) =>
  toolServer('google-drive', { name: 'Google Drive', command: null, builtin: true, ...overrides });

export const driveStatus = (overrides: Partial<GoogleDriveStatus> = {}): GoogleDriveStatus => ({
  clientConfigured: false,
  clientId: null,
  hasClientSecret: false,
  state: 'disconnected',
  email: null,
  ...overrides,
});

export const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'k1',
  role: 'assistant',
  content: [{ type: 'text', text: id }],
  status: 'complete',
  seq: 0,
  createdAt: at,
  error: null,
  ...overrides,
});

export function usageTotals(over: Partial<UsageTotals> = {}): UsageTotals {
  return {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costUsdCli: 0,
    anyEstimated: false,
    anyUnpriced: false,
    ...over,
  };
}

export function usageRow(over: Partial<UsageSummaryRow> = {}): UsageSummaryRow {
  return { key: 'k', label: 'Row', provider: null, deleted: false, ...usageTotals(), ...over };
}

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
    conversations: {
      list: vi.fn(async (): Promise<ConversationSummary[]> => []),
      create: vi.fn(async (agentId: string) => conversation('new', { agentId })),
      rename: vi.fn(async (id: string, title: string) => conversation(id, { title })),
      archive: vi.fn(async (id: string, archived: boolean) => conversation(id, { archived })),
      markRead: vi.fn(async () => {}),
      exportMarkdown: vi.fn(async (): Promise<string | null> => '/tmp/out.md'),
    },
    messages: {
      list: vi.fn(async (): Promise<MessagePage> => ({ messages: [], hasMore: false, rev: 0 })),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
    },
    bundle: {
      export: vi.fn(async (): Promise<string | null> => '/tmp/bundle.json'),
      import: vi.fn(async (): Promise<ImportReport | null> => null),
    },
    search: {
      query: vi.fn(async (): Promise<SearchResult> => ({ conversations: [], messages: [] })),
    },
    attachments: {
      add: vi.fn(async (input: AttachmentInput): Promise<AttachmentBlock> => ({
        type: 'document',
        name: input.name,
        mediaType: 'text/plain',
        source: { kind: 'file', path: `01STORED.${input.name}` },
      })),
      url: (path: string) => `att://${path}`,
    },
    dialogs: { pickFolder: vi.fn(async (): Promise<string | null> => '/home/me/work') },
    toolServers: {
      list: vi.fn(async (): Promise<ToolServer[]> => [filesystemServer()]),
      create: vi.fn(async (draft: ToolServerDraft) => toolServer('new', { name: draft.name })),
      update: vi.fn(async (id: string) => toolServer(id)),
      delete: vi.fn(async () => {}),
      test: vi.fn(async (): Promise<ToolDef[]> => [{ name: 'read_file', inputSchema: {} }]),
    },
    googleDrive: {
      getStatus: vi.fn(async (): Promise<GoogleDriveStatus> => driveStatus()),
      configure: vi.fn(async (input: GoogleDriveConfigureInput): Promise<GoogleDriveStatus> =>
        driveStatus({
          clientConfigured: true,
          clientId: input.clientId,
          hasClientSecret: !!input.clientSecret,
        }),
      ),
      connect: vi.fn(async (): Promise<GoogleDriveStatus> =>
        driveStatus({
          clientConfigured: true,
          clientId: 'id',
          state: 'connected',
          email: 'ana@example.com',
        }),
      ),
      cancelConnect: vi.fn(async () => {}),
      disconnect: vi.fn(async (): Promise<GoogleDriveStatus> =>
        driveStatus({ clientConfigured: true, clientId: 'id' }),
      ),
    },
    approvals: { decide: vi.fn(async () => {}) },
    usage: {
      summary: vi.fn(async (_range: UsageRange): Promise<UsageSummary> => ({
        totals: usageTotals(),
        byConnection: [],
        byAgent: [],
        byModel: [],
      })),
      timeseries: vi.fn(async (_range: UsageRange): Promise<UsageBucket[]> => []),
      conversation: vi.fn(async (_conversationId: string): Promise<UsageTotals> => usageTotals()),
      export: vi.fn(
        async (_input: UsageRange & { shape?: 'records' | 'summary' }): Promise<string | null> =>
          '/tmp/usage.csv',
      ),
      prices: vi.fn(async (): Promise<ModelPrice[]> => []),
      setPrice: vi.fn(
        async (
          _provider: ProviderId,
          _model: string,
          _prices: ModelPrices,
        ): Promise<ModelPrice[]> => [],
      ),
      clearPrice: vi.fn(async (_provider: ProviderId, _model: string): Promise<ModelPrice[]> => []),
    },
    onEvent: vi.fn(() => () => {}),
  } satisfies Backend;
  return backend;
}
