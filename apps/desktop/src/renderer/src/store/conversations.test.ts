import { describe, expect, it } from 'vitest';
import { BackendError } from '../backend/Backend';
import { agentStatus, agentUnread, createConversationsStore, isRunning } from './conversations';
import { conversation, fakeBackend, message } from './testBackend';

const summary = (id: string, over: Parameters<typeof conversation>[1] = {}, unread = 0) => ({
  conversation: conversation(id, over),
  unread,
});

describe('conversations store', () => {
  it('loads conversations per agent, newest activity first, with unread counts', async () => {
    const backend = fakeBackend();
    backend.conversations.list.mockResolvedValue([
      summary('k1', { lastActivityAt: '2026-09-21T10:00:00.000Z' }, 2),
      summary('k2', { lastActivityAt: '2026-09-21T11:00:00.000Z' }),
      summary('k3', { agentId: 'a2' }, 1),
    ]);
    const store = createConversationsStore(backend);
    await store.getState().load();
    const s = store.getState();
    expect(s.idsByAgent).toEqual({ a1: ['k2', 'k1'], a2: ['k3'] });
    expect(agentUnread(s, 'a1')).toBe(2);
    expect(agentUnread(s, 'a2')).toBe(1);
    expect(s.loaded).toBe(true);
  });

  it('derives agent status: running wins over error, error over idle', () => {
    const store = createConversationsStore(fakeBackend());
    const update = (id: string, status: 'idle' | 'running' | 'error') =>
      store
        .getState()
        .handleEvent({ type: 'conversation.updated', conversation: conversation(id, { status }) });
    update('k1', 'idle');
    expect(agentStatus(store.getState(), 'a1')).toBe('idle');
    update('k2', 'error');
    expect(agentStatus(store.getState(), 'a1')).toBe('error');
    update('k1', 'running');
    expect(agentStatus(store.getState(), 'a1')).toBe('running');
    expect(isRunning(store.getState(), 'k1')).toBe(true);
    expect(isRunning(store.getState(), 'k2')).toBe(false);
    expect(agentStatus(store.getState(), 'nobody')).toBe('idle');
  });

  it('reorders when activity changes and keeps list identity for other agents', () => {
    const store = createConversationsStore(fakeBackend());
    const put = (id: string, agentId: string, at: string) =>
      store.getState().handleEvent({
        type: 'conversation.updated',
        conversation: conversation(id, { agentId, lastActivityAt: at }),
      });
    put('k1', 'a1', '2026-09-21T10:00:00.000Z');
    put('k2', 'a1', '2026-09-21T11:00:00.000Z');
    put('k3', 'a2', '2026-09-21T11:00:00.000Z');
    const a2 = store.getState().idsByAgent.a2;
    put('k1', 'a1', '2026-09-21T12:00:00.000Z');
    expect(store.getState().idsByAgent.a1).toEqual(['k1', 'k2']);
    expect(store.getState().idsByAgent.a2).toBe(a2);
  });

  it('counts a finished reply as unread unless its conversation is on screen', () => {
    const backend = fakeBackend();
    const store = createConversationsStore(backend);
    const reply = (conversationId: string, status: 'streaming' | 'complete' | 'error', rev = 1) =>
      store.getState().handleEvent({
        type: 'message.updated',
        message: message('m', { conversationId, status }),
        rev,
      });
    store
      .getState()
      .handleEvent({ type: 'conversation.updated', conversation: conversation('k1') });
    store
      .getState()
      .handleEvent({ type: 'conversation.updated', conversation: conversation('k2') });
    store.getState().setVisible('k1');
    reply('k1', 'streaming');
    reply('k1', 'complete');
    reply('k2', 'streaming');
    reply('k2', 'error');
    expect(store.getState().unread).toMatchObject({ k1: 0, k2: 1 });
    expect(backend.conversations.markRead).toHaveBeenCalledWith('k1');
    // User messages never count.
    store.getState().handleEvent({
      type: 'message.updated',
      message: message('u', { conversationId: 'k2', role: 'user' }),
      rev: 3,
    });
    expect(store.getState().unread.k2).toBe(1);
    // Opening it reads it.
    store.getState().setVisible('k2');
    expect(store.getState().unread.k2).toBe(0);
    expect(backend.conversations.markRead).toHaveBeenCalledWith('k2');
  });

  it('creates and selects, archives and clears the selection, renames', async () => {
    const backend = fakeBackend();
    const store = createConversationsStore(backend);
    expect(await store.getState().create('a1')).toBe('new');
    expect(store.getState().selectedByAgent.a1).toBe('new');
    expect(store.getState().idsByAgent.a1).toEqual(['new']);

    backend.conversations.rename.mockResolvedValueOnce(conversation('new', { title: 'Plans' }));
    await store.getState().rename('new', 'Plans');
    expect(store.getState().byId.new!.title).toBe('Plans');

    backend.conversations.archive.mockResolvedValueOnce(conversation('new', { archived: true }));
    await store.getState().archive('new', true);
    expect(store.getState().idsByAgent.a1).toEqual([]);
    expect(store.getState().archivedIdsByAgent.a1).toEqual(['new']);
    expect(store.getState().selectedByAgent.a1).toBeNull();
  });

  it('loads archived conversations once per agent', async () => {
    const backend = fakeBackend();
    backend.conversations.list.mockResolvedValue([summary('old', { archived: true })]);
    const store = createConversationsStore(backend);
    await store.getState().loadArchived('a1');
    await store.getState().loadArchived('a1');
    expect(backend.conversations.list).toHaveBeenCalledTimes(1);
    expect(backend.conversations.list).toHaveBeenCalledWith({ agentId: 'a1', archived: true });
    expect(store.getState().archivedIdsByAgent.a1).toEqual(['old']);
  });

  it('forgets a deleted agent and its conversations', async () => {
    const backend = fakeBackend();
    backend.conversations.list.mockResolvedValue([
      summary('k1', {}, 2),
      summary('k2', { agentId: 'a2' }, 1),
    ]);
    const store = createConversationsStore(backend);
    await store.getState().load();
    store.getState().select('a1', 'k1');
    store.getState().setVisible('k1');
    store.getState().forgetAgent('a1');
    const s = store.getState();
    expect(Object.keys(s.byId)).toEqual(['k2']);
    expect(s.idsByAgent).toEqual({ a2: ['k2'] });
    expect(s.selectedByAgent).toEqual({});
    expect(s.visibleId).toBeNull();
    expect(agentUnread(s, 'a2')).toBe(1);
  });

  it('shows failures as a notice by code', async () => {
    const backend = fakeBackend();
    backend.conversations.create.mockRejectedValueOnce(new BackendError('not_found', 'x', false));
    const store = createConversationsStore(backend);
    expect(await store.getState().create('a1')).toBeNull();
    expect(store.getState().notice).toBe('not_found');
  });
});
