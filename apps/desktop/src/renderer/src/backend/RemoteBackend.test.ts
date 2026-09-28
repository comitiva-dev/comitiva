import { describe, expect, it, vi } from 'vitest';
import type { HubEvent, SharedAgent, WorkspaceToolServer } from '@comitiva/contract';
import type { Backend, BackendEvent } from './Backend';
import { invitationToken } from './hub/HubApi';
import type { HubExecutor, HubTransport } from './hub/HubTransport';
import { RemoteBackend, toAgent, toToolServer } from './RemoteBackend';

const now = '2026-09-28T12:00:00.000Z';
const shared: SharedAgent = {
  id: 'a1',
  workspaceId: 'w1',
  name: 'Researcher',
  avatar: { color: 'indigo' },
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  role: 'Be brief.',
  params: {},
  toolServerIds: ['ts-shared'],
  permissionPolicy: 'ask',
  tags: [],
  createdBy: 'u1',
  createdAt: now,
  updatedAt: now,
};

function setup() {
  let emitEvent!: (channel: string, event: HubEvent) => void;
  const transport: HubTransport = {
    request: vi.fn(async () => []) as never,
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    onEvent: (h) => {
      emitEvent = h;
      return () => {};
    },
    onPresence: () => () => {},
  };
  const executor = { links: vi.fn(async () => []) } as unknown as HubExecutor;
  const local = { onEvent: () => () => {} } as unknown as Backend;
  const backend = new RemoteBackend({
    local,
    transport,
    executor,
    workspace: { id: 'w1', name: 'Research', role: 'member', userId: 'u2' },
  });
  const events: BackendEvent[] = [];
  backend.onEvent((e) => events.push(e));
  return { backend, transport, events, emit: (c: string, e: HubEvent) => emitEvent(c, e) };
}

describe('RemoteBackend', () => {
  it('shows a shared agent with this member’s link, or no connection before one', () => {
    expect(toAgent(shared, null)).toMatchObject({
      connectionId: '',
      roots: [],
      toolServerIds: ['ts-shared'],
    });
    const linked = toAgent(shared, {
      agentId: 'a1',
      workspaceId: 'w1',
      connectionId: 'c-mine',
      roots: [{ path: '/home/bea/notes', mode: 'read' }],
      toolServerIds: ['filesystem'],
    });
    expect(linked).toMatchObject({
      connectionId: 'c-mine',
      roots: [{ path: '/home/bea/notes', mode: 'read' }],
      toolServerIds: ['ts-shared', 'filesystem'],
      fallbackConnectionIds: [],
    });
  });

  it('shows a workspace server’s secret headers as secrets, never as values', () => {
    const server: WorkspaceToolServer = {
      id: 'ts1',
      workspaceId: 'w1',
      name: 'Search',
      transport: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: { secretRef: 'member' }, 'X-Team': { value: 'r' } },
      enabled: true,
      createdBy: null,
      createdAt: now,
    };
    expect(toToolServer(server).headers).toEqual({
      Authorization: { secretRef: 'hubToolServer:ts1:header:Authorization' },
      'X-Team': { value: 'r' },
    });
  });

  it('turns the hub’s run events into the window’s message events, for channels it listens to', async () => {
    const { backend, transport, events, emit } = setup();
    await backend.messages.list('c1');
    expect(transport.subscribe).toHaveBeenCalledWith('private-conversation.c1');
    const ref = { conversationId: 'c1', messageId: 'm1', runId: 'r1' };
    emit('private-conversation.c1', { type: 'run.text_delta', ...ref, rev: 3, text: 'Hi' });
    emit('private-conversation.c1', {
      type: 'run.tool_result',
      ...ref,
      rev: 4,
      toolUseId: 't1',
      output: [{ type: 'text', text: 'ok' }],
      isError: false,
      durationMs: 2,
    });
    emit('private-conversation.c1', { type: 'run.done', ...ref, stopReason: 'end_turn' });
    emit('private-conversation.other', {
      type: 'run.text_delta',
      ...ref,
      conversationId: 'other',
      rev: 1,
      text: 'x',
    });
    expect(events).toEqual([
      { type: 'message.delta', conversationId: 'c1', messageId: 'm1', rev: 3, text: 'Hi' },
      {
        type: 'message.block',
        conversationId: 'c1',
        messageId: 'm1',
        rev: 4,
        block: {
          type: 'tool_result',
          toolUseId: 't1',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          durationMs: 2,
        },
      },
    ]);
  });

  it('asks for a reload when a reply finishes in a conversation not open here', async () => {
    vi.useFakeTimers();
    const { events, emit } = setup();
    const conversation = {
      id: 'c9',
      agentId: 'a1',
      title: null,
      status: 'running' as const,
      harnessSessionId: null,
      archived: false,
      lastActivityAt: now,
      createdAt: now,
    };
    const update = (status: 'running' | 'idle') => ({
      type: 'conversation.updated' as const,
      workspaceId: 'w1',
      conversation: { ...conversation, status },
      pendingApproval: null,
      runner: null,
    });
    emit('presence-workspace.w1', update('running'));
    emit('presence-workspace.w1', update('idle'));
    vi.advanceTimersByTime(400);
    expect(events.map((e) => e.type)).toEqual([
      'conversation.updated',
      'conversation.updated',
      'workspace.changed',
    ]);
    vi.useRealTimers();
  });
});

describe('RemoteBackend agents', () => {
  it('saves a member’s own connection without touching the shared agent when nothing shared changed', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const hubAgent = { ...shared, params: { temperature: 0.2, maxTokens: 100 } };
    const transport: HubTransport = {
      request: vi.fn(async (method: string, path: string, options?: { body?: unknown }) => {
        requests.push({ method, path, body: options?.body });
        if (path.endsWith('/tool-servers')) return [{ id: 'ts-shared' }];
        return hubAgent;
      }) as never,
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onEvent: () => () => {},
      onPresence: () => () => {},
    };
    const setLink = vi.fn(async (link) => link);
    const backend = new RemoteBackend({
      local: { onEvent: () => () => {} } as unknown as Backend,
      transport,
      executor: { links: vi.fn(async () => []), setLink } as unknown as HubExecutor,
      workspace: { id: 'w1', name: 'Research', role: 'member', userId: 'u2' },
    });
    // What the edit form sends: every field, the shared ones unchanged (keys in another order).
    const agent = await backend.agents.update('a1', {
      name: 'Researcher',
      avatar: { color: 'indigo' },
      connectionId: 'c-mine',
      model: 'claude-haiku-4-5',
      role: 'Be brief.',
      params: { maxTokens: 100, temperature: 0.2 },
      tags: [],
      toolServerIds: ['ts-shared', 'filesystem'],
      roots: [{ path: '/home/bea/notes', mode: 'readwrite' }],
      permissionPolicy: 'ask',
    });
    expect(requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(setLink).toHaveBeenCalledWith({
      agentId: 'a1',
      workspaceId: 'w1',
      connectionId: 'c-mine',
      roots: [{ path: '/home/bea/notes', mode: 'readwrite' }],
      toolServerIds: ['filesystem'],
    });
    expect(agent.connectionId).toBe('c-mine');

    await backend.agents.update('a1', { role: 'Be thorough.' });
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { role: 'Be thorough.' },
    ]);
  });
});

describe('invitation links', () => {
  it('takes the token from a link or on its own', () => {
    expect(invitationToken('https://hub.example.com/invite/abcdefghijklmnopqrstuvwx')).toBe(
      'abcdefghijklmnopqrstuvwx',
    );
    expect(invitationToken('  abcdefghijklmnopqrstuvwx ')).toBe('abcdefghijklmnopqrstuvwx');
    expect(invitationToken('not a link')).toBeNull();
  });
});
