import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../Database';
import { AgentRepository } from './AgentRepository';
import { ConnectionRepository } from './ConnectionRepository';
import { ConversationRepository } from './ConversationRepository';
import { MessageRepository } from './MessageRepository';
import { UsageRepository } from './UsageRepository';

const migrations = join(__dirname, '..', 'migrations');
let db: Database;
let conversations: ConversationRepository;
let messages: MessageRepository;

const text = (t: string) => [{ type: 'text' as const, text: t }];

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  new ConnectionRepository(db).create({
    id: 'c1',
    name: 'Ollama',
    provider: 'ollama',
    config: { defaultModel: 'llama3' },
    secretRef: null,
  });
  const agents = new AgentRepository(db);
  for (const id of ['a1', 'a2']) {
    agents.create({
      id,
      name: id,
      avatar: { color: 'indigo' },
      connectionId: 'c1',
      model: null,
      role: '',
      params: {},
      tags: [],
      toolServerIds: [],
      roots: [],
      permissionPolicy: 'ask',
    });
  }
});

describe('ConversationRepository', () => {
  it('creates idle, untitled conversations and lists them by activity, per agent', () => {
    const a = conversations.create('a1', '2026-09-20T10:00:00.000Z');
    const b = conversations.create('a1', '2026-09-20T11:00:00.000Z');
    conversations.create('a2', '2026-09-20T12:00:00.000Z');
    expect(a).toMatchObject({ agentId: 'a1', title: null, status: 'idle', archived: false });
    expect(
      conversations.list({ agentId: 'a1', archived: false }).map((s) => s.conversation.id),
    ).toEqual([b.id, a.id]);
    conversations.touch(a.id, '2026-09-20T13:00:00.000Z');
    expect(conversations.list({ archived: false }).map((s) => s.conversation.id)[0]).toBe(a.id);
  });

  it('archives, renames and sets status; unknown ids are not_found', () => {
    const c = conversations.create('a1');
    expect(conversations.rename(c.id, 'Plans').title).toBe('Plans');
    conversations.setArchived(c.id, true);
    expect(conversations.list({ archived: false })).toEqual([]);
    expect(conversations.list({ archived: true })).toHaveLength(1);
    expect(conversations.setStatus(c.id, 'running').status).toBe('running');
    expect(() => conversations.rename('nope', 'x')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('counts final assistant replies past the read mark as unread', () => {
    const c = conversations.create('a1');
    messages.insert(c.id, 'user', text('hi'), 'complete');
    messages.insert(c.id, 'assistant', text('hello'), 'complete');
    messages.insert(c.id, 'user', text('again'), 'complete');
    messages.insert(c.id, 'assistant', text('stream'), 'streaming');
    expect(conversations.list({ archived: false })[0]!.unread).toBe(1);
    conversations.markRead(c.id);
    expect(conversations.list({ archived: false })[0]!.unread).toBe(0);
    messages.insert(c.id, 'assistant', text('late'), 'error');
    expect(conversations.list({ archived: false })[0]!.unread).toBe(1);
  });

  it('scopes the harness session to the connection that created it', () => {
    const c = conversations.create('a1');
    conversations.setHarnessSession(c.id, 'sess-1', 'c1');
    expect(conversations.harnessSession(c.id, 'c1')).toBe('sess-1');
    expect(conversations.harnessSession(c.id, 'c2')).toBeUndefined();
    expect(conversations.get(c.id)!.harnessSessionId).toBe('sess-1');
  });

  it('recovers conversations and replies left running by a crash', () => {
    const c = conversations.create('a1');
    const idle = conversations.create('a1');
    conversations.setStatus(c.id, 'running');
    const m = messages.insert(c.id, 'assistant', text('par'), 'streaming');
    expect(conversations.recoverInterrupted()).toEqual([c.id]);
    messages.recoverInterrupted();
    expect(conversations.get(c.id)!.status).toBe('error');
    expect(conversations.get(idle.id)!.status).toBe('idle');
    expect(messages.get(m.id)).toMatchObject({
      status: 'error',
      content: text('par'),
      error: { code: 'interrupted', retryable: true },
    });
  });

  it('deletes conversations, messages with the agent', () => {
    const c = conversations.create('a1');
    messages.insert(c.id, 'user', text('hi'), 'complete');
    new AgentRepository(db).delete('a1');
    expect(conversations.get(c.id)).toBeNull();
    expect(messages.all(c.id)).toEqual([]);
  });
});

describe('MessageRepository', () => {
  it('numbers messages per conversation and pages from the newest', () => {
    const c = conversations.create('a1');
    const other = conversations.create('a2');
    for (let i = 0; i < 5; i++) messages.insert(c.id, 'user', text(`m${i}`), 'complete');
    expect(messages.insert(other.id, 'user', text('x'), 'complete').seq).toBe(0);
    const latest = messages.page(c.id, { limit: 2 });
    expect(latest.messages.map((m) => m.seq)).toEqual([3, 4]);
    expect(latest.hasMore).toBe(true);
    const older = messages.page(c.id, { beforeSeq: 3, limit: 5 });
    expect(older.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(older.hasMore).toBe(false);
  });

  it('checkpoints, finishes and resets a reply, validating content', () => {
    const c = conversations.create('a1');
    const m = messages.insert(c.id, 'assistant', [], 'streaming');
    messages.setContent(m.id, text('par'));
    expect(messages.get(m.id)!.content).toEqual(text('par'));
    const error = { code: 'rate_limited' as const, message: '429', retryable: true };
    expect(messages.finish(m.id, 'error', text('partial'), error)).toMatchObject({
      status: 'error',
      error,
    });
    expect(messages.reset(m.id)).toMatchObject({ status: 'streaming', content: [], error: null });
    expect(() => messages.setContent(m.id, [{ type: 'nope' } as never])).toThrow();
  });
});

describe('UsageRepository', () => {
  it('stores one record per run with the estimated cost column', () => {
    const c = conversations.create('a1');
    const usage = new UsageRepository(db);
    usage.insert({
      connectionId: 'c1',
      agentId: 'a1',
      conversationId: c.id,
      messageId: null,
      model: 'llama3',
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      estimated: true,
      estimatedCostUsd: null,
      latencyMs: 120,
    });
    expect(usage.listByConversation(c.id)).toEqual([
      expect.objectContaining({
        model: 'llama3',
        outputTokens: 3,
        estimated: true,
        latencyMs: 120,
      }),
    ]);
  });
});
