import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  type Block,
  type Message,
  type RunEvent,
  type RunEventPayload,
  type TextBlock,
} from '@comitiva/contract';
import type { RunStartPayload } from '@comitiva/runner';
import { Database } from '../db/Database';
import { AgentRepository } from '../db/repositories/AgentRepository';
import { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import { ConversationRepository } from '../db/repositories/ConversationRepository';
import { MessageRepository } from '../db/repositories/MessageRepository';
import { ToolApprovalRepository } from '../db/repositories/ToolApprovalRepository';
import { ToolServerRepository } from '../db/repositories/ToolServerRepository';
import { UsageRepository } from '../db/repositories/UsageRepository';
import { MemorySecrets } from '../testing/MemorySecrets';
import {
  buildHistory,
  ConversationService,
  type ConversationEvents,
  type RunnerPort,
} from './ConversationService';
import { TitleService } from './TitleService';
import { ToolServerService } from './ToolServerService';

/** Records run requests; tests play the runner's events with `send`. */
class FakeRunner extends EventEmitter<{ 'run.event': [RunEvent & { receivedAt: number }] }> {
  readonly started: RunStartPayload[] = [];
  readonly cancelled: string[] = [];
  readonly approved: Array<{ runId: string; toolUseId: string; decision: string }> = [];
  startRun(payload: RunStartPayload) {
    this.started.push(payload);
    return { runId: payload.runId! };
  }
  cancelRun(runId: string) {
    this.cancelled.push(runId);
  }
  approve(runId: string, toolUseId: string, decision: string) {
    this.approved.push({ runId, toolUseId, decision });
  }
  send(runId: string, event: RunEventPayload, receivedAt = Date.now()) {
    this.emit('run.event', { ...event, runId, receivedAt } as RunEvent & { receivedAt: number });
  }
  lastRunId(): string {
    return this.started.at(-1)!.runId!;
  }
}

type Emitted = {
  [C in keyof ConversationEvents]: { channel: C; payload: ConversationEvents[C][0] };
}[keyof ConversationEvents];

const text = (t: string): TextBlock[] => [{ type: 'text', text: t }];
const usage = (
  over: Partial<Extract<RunEventPayload, { type: 'run.usage' }>> = {},
): RunEventPayload => ({
  type: 'run.usage',
  inputTokens: 12,
  outputTokens: 5,
  estimated: false,
  ...over,
});
const done = (stopReason: 'end_turn' | 'cancelled' = 'end_turn'): RunEventPayload => ({
  type: 'run.done',
  stopReason,
});

let db: Database;
let runner: FakeRunner;
let conversations: ConversationRepository;
let messages: MessageRepository;
let usageRepo: UsageRepository;
let agents: AgentRepository;
let connections: ConnectionRepository;
let secretFor: ReturnType<typeof vi.fn>;
let title: { generate: ReturnType<typeof vi.fn> };
let service: ConversationService;
let events: Emitted[];

function makeService(titleService: unknown = title) {
  const s = new ConversationService({
    db,
    conversations,
    messages,
    usage: usageRepo,
    agents,
    connections,
    secretFor: secretFor as never,
    runner: runner as unknown as RunnerPort,
    title: titleService as TitleService,
    workspacesDir: '/data/workspaces',
    toolServers: new ToolServerService({
      repo: new ToolServerRepository(db),
      secrets: new MemorySecrets(),
      runner: { startToolServer: vi.fn(), stopToolServer: vi.fn() } as never,
      filesystem: { command: '/app/node', args: ['/app/filesystem.cjs'], env: {} },
    }),
    approvals: new ToolApprovalRepository(db),
  });
  for (const channel of [
    'conversation.updated',
    'message.updated',
    'message.delta',
    'message.block',
  ] as const) {
    s.on(channel, ((payload: unknown) => {
      events.push({ channel, payload } as Emitted);
    }) as never);
  }
  return s;
}

const agentDraft = (id: string, connectionId: string) => ({
  id,
  name: id,
  avatar: { color: 'indigo' as const },
  connectionId,
  model: null,
  role: 'Be brief.',
  params: {},
  tags: [],
  toolServerIds: [],
  roots: [],
  permissionPolicy: 'ask' as const,
});

beforeEach(() => {
  vi.useFakeTimers();
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'db', 'migrations'));
  runner = new FakeRunner();
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  usageRepo = new UsageRepository(db);
  agents = new AgentRepository(db);
  connections = new ConnectionRepository(db);
  connections.create({
    id: 'c-api',
    name: 'Anthropic',
    provider: 'anthropic',
    config: { defaultModel: 'claude-sonnet-5' },
    secretRef: 'connection:c-api',
  });
  connections.create({
    id: 'c-cli',
    name: 'Claude Code',
    provider: 'claude-code',
    config: {},
    secretRef: null,
  });
  connections.create({
    id: 'c-cli2',
    name: 'Codex',
    provider: 'codex',
    config: {},
    secretRef: null,
  });
  agents.create(agentDraft('a1', 'c-api'));
  agents.create(agentDraft('a2', 'c-api'));
  agents.create(agentDraft('a-cli', 'c-cli'));
  secretFor = vi.fn(async (c: { kind: string }) => (c.kind === 'api' ? 'sk-test' : undefined));
  title = { generate: vi.fn(async () => null) };
  events = [];
  service = makeService();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

const of = <C extends Emitted['channel']>(channel: C) =>
  events.filter((e) => e.channel === channel).map((e) => e.payload) as ConversationEvents[C][0][];

async function started(agentId = 'a1', message = 'Hello there') {
  const conversation = service.create(agentId);
  await service.sendMessage(conversation.id, text(message));
  const runId = runner.lastRunId();
  const reply = messages.last(conversation.id)!;
  return { conversation, runId, reply };
}

describe('ConversationService: sending and streaming', () => {
  it('persists the user message and an empty reply, then starts the run with the history', async () => {
    const { conversation, reply } = await started();
    const [user] = messages.all(conversation.id);
    expect(user).toMatchObject({
      role: 'user',
      status: 'complete',
      content: text('Hello there'),
      seq: 0,
    });
    expect(reply).toMatchObject({ role: 'assistant', status: 'streaming', content: [], seq: 1 });
    expect(conversations.get(conversation.id)!.status).toBe('running');

    const req = runner.started[0]!;
    expect(req).toMatchObject({ conversationId: conversation.id, secret: 'sk-test' });
    expect(req.agent.id).toBe('a1');
    expect(req.connection.id).toBe('c-api');
    expect(req.messages.map((m) => m.id)).toEqual([user!.id]);
    expect(req).not.toHaveProperty('harnessSessionId');
    expect(req).not.toHaveProperty('workingDirectory');

    expect(of('message.updated').map((p) => p.message.id)).toEqual([user!.id, reply.id]);
    expect(of('conversation.updated').at(-1)!.conversation.status).toBe('running');
  });

  it('coalesces deltas to the UI per frame and checkpoints to SQLite about every 250 ms', async () => {
    const { conversation, runId, reply } = await started();
    const setContent = vi.spyOn(messages, 'setContent');
    let full = '';
    for (let i = 0; i < 100; i++) {
      runner.send(runId, { type: 'run.text_delta', text: `t${i} ` });
      full += `t${i} `;
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(20);
    const deltas = of('message.delta');
    // 500 ms of streaming at 16 ms per flush: ~32 UI messages, not 100.
    expect(deltas.length).toBeGreaterThan(20);
    expect(deltas.length).toBeLessThan(40);
    // Revs 1 and 2 went to the user message and the empty reply.
    expect(deltas.map((d) => d.rev)).toEqual(deltas.map((_, i) => i + 3));
    expect(deltas.map((d) => d.text).join('')).toBe(full);
    expect(
      deltas.every((d) => d.messageId === reply.id && d.conversationId === conversation.id),
    ).toBe(true);
    // 500 ms → 2 checkpoints, not 100 UPDATEs.
    expect(setContent.mock.calls.length).toBeLessThanOrEqual(3);
    vi.advanceTimersByTime(250);
    expect(messages.get(reply.id)!.content).toEqual(text(full));

    runner.send(runId, usage());
    runner.send(runId, done());
    expect(messages.get(reply.id)).toMatchObject({
      status: 'complete',
      content: text(full),
      error: null,
    });
    expect(conversations.get(conversation.id)!.status).toBe('idle');
    expect(of('message.updated').at(-1)!.message).toMatchObject({
      id: reply.id,
      status: 'complete',
    });
    expect(of('conversation.updated').at(-1)!.conversation.status).toBe('idle');
  });

  it('sends pending text before a block, and text after a tool block starts a new text block', async () => {
    const { runId, reply } = await started();
    const tool: Block = {
      type: 'tool_use',
      id: 't1',
      toolServerId: 'harness:claude-code',
      name: 'Read',
      input: {},
    };
    runner.send(runId, { type: 'run.text_delta', text: 'Looking' });
    runner.send(runId, { type: 'run.block', block: tool });
    runner.send(runId, { type: 'run.text_delta', text: 'Found it' });
    runner.send(runId, done());
    const live = events.filter(
      (e) => e.channel === 'message.delta' || e.channel === 'message.block',
    );
    expect(live.map((e) => [e.channel, e.payload.rev])).toEqual([
      ['message.delta', 3],
      ['message.block', 4],
      ['message.delta', 5],
    ]);
    expect(messages.get(reply.id)!.content).toEqual([
      ...text('Looking'),
      tool,
      ...text('Found it'),
    ]);
  });

  it('records one usage row per run with the model and the run duration', async () => {
    const { conversation, runId, reply } = await started();
    const t0 = Date.now();
    runner.send(runId, usage({ cacheReadTokens: 3 }));
    runner.send(runId, done(), t0 + 1234);
    expect(usageRepo.listByConversation(conversation.id)).toEqual([
      expect.objectContaining({
        connectionId: 'c-api',
        agentId: 'a1',
        messageId: reply.id,
        model: 'claude-sonnet-5',
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: null,
        estimated: false,
        estimatedCostUsd: null,
        latencyMs: 1234,
      }),
    ]);
  });

  it('keeps two conversations streaming at once apart', async () => {
    const a = await started('a1', 'first');
    const b = await started('a2', 'second');
    for (let i = 0; i < 5; i++) {
      runner.send(a.runId, { type: 'run.text_delta', text: 'A' });
      runner.send(b.runId, { type: 'run.text_delta', text: 'B' });
    }
    expect(conversations.get(a.conversation.id)!.status).toBe('running');
    expect(conversations.get(b.conversation.id)!.status).toBe('running');
    runner.send(a.runId, usage({ outputTokens: 1 }));
    runner.send(a.runId, done());
    expect(conversations.get(a.conversation.id)!.status).toBe('idle');
    expect(conversations.get(b.conversation.id)!.status).toBe('running');
    runner.send(b.runId, { type: 'run.text_delta', text: 'B' });
    runner.send(b.runId, usage({ outputTokens: 2 }));
    runner.send(b.runId, done());
    expect(messages.get(a.reply.id)!.content).toEqual(text('AAAAA'));
    expect(messages.get(b.reply.id)!.content).toEqual(text('BBBBBB'));
    expect(usageRepo.listByConversation(a.conversation.id).map((u) => u.outputTokens)).toEqual([1]);
    expect(usageRepo.listByConversation(b.conversation.id).map((u) => u.outputTokens)).toEqual([2]);
    vi.advanceTimersByTime(20);
    const deltas = of('message.delta');
    expect(
      deltas
        .filter((d) => d.messageId === a.reply.id)
        .map((d) => d.text)
        .join(''),
    ).toBe('AAAAA');
    expect(
      deltas
        .filter((d) => d.messageId === b.reply.id)
        .map((d) => d.text)
        .join(''),
    ).toBe('BBBBBB');
  });
});

describe('ConversationService: guards and refusals', () => {
  it('refuses a second send while a run is starting or streaming', async () => {
    const conversation = service.create('a1');
    const first = service.sendMessage(conversation.id, text('one'));
    await expect(service.sendMessage(conversation.id, text('two'))).rejects.toMatchObject({
      code: 'conversation_busy',
    });
    await first;
    await expect(service.sendMessage(conversation.id, text('two'))).rejects.toMatchObject({
      code: 'conversation_busy',
    });
    expect(runner.started).toHaveLength(1);
    runner.send(runner.lastRunId(), done());
    await service.sendMessage(conversation.id, text('two'));
    expect(runner.started).toHaveLength(2);
    expect(messages.all(conversation.id).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('persists nothing when the run cannot start: disabled connection, missing key', async () => {
    const conversation = service.create('a1');
    secretFor.mockRejectedValueOnce(new AppError('secret_missing', 'no key'));
    await expect(service.sendMessage(conversation.id, text('hi'))).rejects.toMatchObject({
      code: 'secret_missing',
    });
    connections.update('c-api', { enabled: false });
    await expect(service.sendMessage(conversation.id, text('hi'))).rejects.toMatchObject({
      code: 'connection_disabled',
    });
    expect(messages.all(conversation.id)).toEqual([]);
    expect(conversations.get(conversation.id)).toMatchObject({ status: 'idle', title: null });
    expect(runner.started).toEqual([]);
  });

  it('refuses unknown conversations and agents', async () => {
    await expect(service.sendMessage('nope', text('hi'))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(() => service.create('nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('ConversationService: cancel, errors and retry', () => {
  it('cancel leaves the reply cancelled with its partial content and estimated usage', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, { type: 'run.text_delta', text: 'Partial' });
    service.cancel(conversation.id);
    service.cancel(conversation.id); // idempotent
    expect(runner.cancelled).toEqual([runId]);
    runner.send(runId, usage({ estimated: true }));
    runner.send(runId, done('cancelled'));
    expect(messages.get(reply.id)).toMatchObject({ status: 'cancelled', content: text('Partial') });
    expect(conversations.get(conversation.id)!.status).toBe('idle');
    expect(usageRepo.listByConversation(conversation.id)[0]!.estimated).toBe(true);
    // Nothing is left pending: the next grace period does not rewrite the reply.
    vi.advanceTimersByTime(20_000);
    expect(
      of('message.updated')
        .filter((p) => p.message.id === reply.id)
        .at(-1)!.message.status,
    ).toBe('cancelled');
  });

  it('finalizes a cancel locally when the runner never answers', async () => {
    const { conversation, reply } = await started();
    service.cancel(conversation.id);
    vi.advanceTimersByTime(10_000);
    expect(messages.get(reply.id)!.status).toBe('cancelled');
    expect(conversations.get(conversation.id)!.status).toBe('idle');
    await service.sendMessage(conversation.id, text('again'));
    expect(runner.started).toHaveLength(2);
  });

  it('an error leaves the reply in error, and retry runs it again in the same message', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, { type: 'run.text_delta', text: 'Half' });
    runner.send(runId, {
      type: 'run.error',
      code: 'rate_limited',
      message: '429 slow down',
      retryable: true,
    });
    expect(messages.get(reply.id)).toMatchObject({
      status: 'error',
      content: text('Half'),
      error: { code: 'rate_limited', retryable: true },
    });
    expect(conversations.get(conversation.id)!.status).toBe('error');

    await service.retryLast(conversation.id);
    expect(messages.get(reply.id)).toMatchObject({ status: 'streaming', content: [], error: null });
    expect(conversations.get(conversation.id)!.status).toBe('running');
    const retry = runner.started[1]!;
    expect(retry.messages.map((m) => m.role)).toEqual(['user']);
    runner.send(retry.runId!, { type: 'run.text_delta', text: 'Whole' });
    runner.send(retry.runId!, done());
    expect(messages.get(reply.id)).toMatchObject({ status: 'complete', content: text('Whole') });
    expect(messages.all(conversation.id)).toHaveLength(2);
    expect(conversations.get(conversation.id)!.status).toBe('idle');
  });

  it('retry refuses when the last reply did not fail, or while running', async () => {
    const { conversation, runId } = await started();
    await expect(service.retryLast(conversation.id)).rejects.toMatchObject({
      code: 'conversation_busy',
    });
    runner.send(runId, done());
    await expect(service.retryLast(conversation.id)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('a runner crash ends the reply in a retryable error', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, {
      type: 'run.error',
      code: 'runner_crashed',
      message: 'exited',
      retryable: true,
    });
    expect(messages.get(reply.id)!.error).toMatchObject({
      code: 'runner_crashed',
      retryable: true,
    });
    await service.retryLast(conversation.id);
    expect(runner.started).toHaveLength(2);
  });

  it('ignores events after the terminal one and events of unknown runs', async () => {
    const { runId, reply } = await started();
    runner.send(runId, done());
    runner.send(runId, { type: 'run.text_delta', text: 'late' });
    runner.send('other', { type: 'run.text_delta', text: 'x' });
    expect(messages.get(reply.id)!.content).toEqual([]);
  });
});

describe('ConversationService: CLI harness sessions', () => {
  it('stores the harness session at once and resumes it on the same connection only', async () => {
    const { conversation, runId } = await started('a-cli');
    expect(runner.started[0]).toMatchObject({
      workingDirectory: `/data/workspaces/${conversation.id}`,
    });
    expect(runner.started[0]).not.toHaveProperty('secret');
    runner.send(runId, { type: 'run.session', harnessSessionId: 'sess-1' });
    expect(conversations.get(conversation.id)!.harnessSessionId).toBe('sess-1');
    runner.send(runId, done());

    await service.sendMessage(conversation.id, text('more'));
    expect(runner.started[1]).toMatchObject({ harnessSessionId: 'sess-1' });
    runner.send(runner.lastRunId(), done());

    agents.update('a-cli', { connectionId: 'c-cli2' });
    await service.sendMessage(conversation.id, text('moved'));
    expect(runner.started[2]).not.toHaveProperty('harnessSessionId');
  });

  it('leaves harness tool blocks, errored and empty replies out of the history', () => {
    const at = '2026-09-21T10:00:00.000Z';
    const msg = (
      seq: number,
      role: Message['role'],
      content: Block[],
      status: Message['status'] = 'complete',
    ): Message => ({
      id: `m${seq}`,
      conversationId: 'c',
      role,
      content,
      status,
      seq,
      createdAt: at,
      error: null,
    });
    const harnessUse: Block = {
      type: 'tool_use',
      id: 'h1',
      toolServerId: 'harness:codex',
      name: 'shell',
      input: {},
    };
    const harnessResult: Block = {
      type: 'tool_result',
      toolUseId: 'h1',
      content: text('ok') as never,
      isError: false,
    };
    const history = buildHistory([
      msg(0, 'user', text('q1')),
      msg(1, 'assistant', [...text('a'), harnessUse, harnessResult, ...text('b')]),
      msg(2, 'user', text('q2')),
      msg(3, 'assistant', text('boom'), 'error'),
      msg(4, 'assistant', [], 'cancelled'),
      msg(5, 'assistant', text('partial'), 'cancelled'),
      msg(6, 'user', text('q3')),
    ]);
    expect(history.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm5', 'm6']);
    expect(history[1]!.content).toEqual([...text('a'), ...text('b')]);
  });
});

describe('ConversationService: snapshots, shutdown and recovery', () => {
  it('lists a streaming conversation at a rev that lines up with later deltas', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, { type: 'run.text_delta', text: 'Hel' });
    vi.advanceTimersByTime(20);
    runner.send(runId, { type: 'run.text_delta', text: 'lo' }); // pending, not sent yet
    const page = service.listMessages({ conversationId: conversation.id, limit: 100 });
    // user message 1, empty reply 2, "Hel" 3, "lo" flushed by the list itself 4.
    expect(page.rev).toBe(4);
    expect(page.messages.at(-1)).toMatchObject({
      id: reply.id,
      status: 'streaming',
      content: text('Hello'),
    });
    runner.send(runId, { type: 'run.text_delta', text: '!' });
    vi.advanceTimersByTime(20);
    const after = of('message.delta').filter((d) => d.rev > page.rev);
    expect(after.map((d) => d.text)).toEqual(['!']);
    runner.send(runId, done());
    const final = of('message.updated').at(-1)!;
    const idle = service.listMessages({ conversationId: conversation.id, limit: 100 });
    expect(idle.rev).toBe(final.rev);
    expect(idle.messages.at(-1)).toMatchObject({ status: 'complete', content: text('Hello!') });
  });

  it('numbers every message event of a conversation in order, apart from other conversations', async () => {
    const a = await started('a1');
    const b = await started('a2');
    runner.send(a.runId, { type: 'run.text_delta', text: 'x' });
    runner.send(b.runId, { type: 'run.block', block: text('y')[0]! });
    vi.advanceTimersByTime(20);
    runner.send(a.runId, done());
    runner.send(b.runId, done());
    for (const id of [a.conversation.id, b.conversation.id]) {
      const revs = events
        .filter((e) => e.channel !== 'conversation.updated')
        .filter((e) =>
          e.channel === 'message.updated'
            ? e.payload.message.conversationId === id
            : e.payload.conversationId === id,
        )
        .map((e) => e.payload.rev);
      expect(revs).toEqual(revs.map((_, i) => i + 1));
    }
  });

  it('shutdown finalizes running replies as cancelled', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, { type: 'run.text_delta', text: 'So far' });
    service.shutdown();
    expect(runner.cancelled).toEqual([runId]);
    expect(messages.get(reply.id)).toMatchObject({ status: 'cancelled', content: text('So far') });
    expect(conversations.get(conversation.id)!.status).toBe('idle');
    await expect(service.sendMessage(conversation.id, text('x'))).rejects.toMatchObject({
      code: 'runner_unavailable',
    });
  });

  it('recovers replies and conversations left running by a crash', () => {
    const conversation = conversations.create('a1');
    conversations.setStatus(conversation.id, 'running');
    const reply = messages.insert(conversation.id, 'assistant', text('cut'), 'streaming');
    service.recover();
    expect(messages.get(reply.id)!.error!.code).toBe('interrupted');
    expect(conversations.get(conversation.id)!.status).toBe('error');
  });

  it('forgets the runs of an agent about to be deleted', async () => {
    const { conversation, runId } = await started();
    service.forgetAgent('a1');
    expect(runner.cancelled).toEqual([runId]);
    agents.delete('a1');
    runner.send(runId, done()); // nothing to write any more; must not throw
    expect(conversations.get(conversation.id)).toBeNull();
  });
});

describe('ConversationService: tools and approvals', () => {
  const toolUse = (id: string, name = 'fs__write_file'): RunEventPayload => ({
    type: 'run.block',
    block: { type: 'tool_use', id, toolServerId: 'filesystem', name, input: { path: '/w/a.txt' } },
  });
  const toolCall = (id: string, requiresApproval = true): RunEventPayload => ({
    type: 'run.tool_call',
    toolUseId: id,
    toolServerId: 'filesystem',
    toolName: 'write_file',
    input: { path: '/w/a.txt' },
    requiresApproval,
  });
  const toolResult = (id: string, isError = false): RunEventPayload => ({
    type: 'run.tool_result',
    toolUseId: id,
    output: [{ type: 'text', text: isError ? 'approval_denied: no' : 'Created /w/a.txt' }],
    isError,
    durationMs: 4,
  });

  beforeEach(() => {
    agents.update('a1', {
      toolServerIds: ['filesystem'],
      roots: [{ path: '/w', mode: 'readwrite' }],
    });
  });

  it('starts the run with the agent servers and its always-allowed tools', async () => {
    await started();
    expect(runner.started[0]).toMatchObject({
      toolServers: [
        {
          id: 'filesystem',
          transport: 'stdio',
          builtin: 'filesystem',
          command: '/app/node',
          args: ['/app/filesystem.cjs'],
        },
      ],
      alwaysAllowed: [],
    });
  });

  it('waits for approval: status, pending approval in events and lists, then the decision', async () => {
    const { conversation, runId } = await started();
    runner.send(runId, toolUse('t1'));
    runner.send(runId, toolCall('t1'));
    expect(conversations.get(conversation.id)!.status).toBe('awaiting-approval');
    const pending = {
      toolUseId: 't1',
      toolServerId: 'filesystem',
      toolName: 'write_file',
      input: { path: '/w/a.txt' },
    };
    expect(of('conversation.updated').at(-1)).toMatchObject({ pendingApproval: pending });
    expect(service.list({ archived: false })[0]!.pendingApproval).toEqual(pending);

    expect(() => service.decide(conversation.id, 'other', 'allow')).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    service.decide(conversation.id, 't1', 'allow');
    expect(runner.approved).toEqual([{ runId, toolUseId: 't1', decision: 'allow' }]);
    expect(conversations.get(conversation.id)!.status).toBe('running');
    expect(of('conversation.updated').at(-1)).toMatchObject({ pendingApproval: null });
    expect(service.list({ archived: false })[0]!.pendingApproval).toBeNull();
    // A decision is taken once.
    expect(() => service.decide(conversation.id, 't1', 'allow')).toThrow();
  });

  it('persists tool_use and tool_result blocks in the reply and sends them in the next history', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, { type: 'run.text_delta', text: 'Writing. ' });
    runner.send(runId, toolUse('t1'));
    runner.send(runId, toolCall('t1'));
    service.decide(conversation.id, 't1', 'allow');
    runner.send(runId, toolResult('t1'));
    runner.send(runId, { type: 'run.text_delta', text: 'Done.' });
    runner.send(runId, usage());
    runner.send(runId, done());
    const saved = messages.get(reply.id)!;
    expect(saved.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_result', 'text']);
    expect(saved.content[2]).toEqual({
      type: 'tool_result',
      toolUseId: 't1',
      content: [{ type: 'text', text: 'Created /w/a.txt' }],
      isError: false,
      durationMs: 4,
    });
    expect(of('message.block').map((e) => e.block.type)).toEqual(['tool_use', 'tool_result']);
    expect(conversations.get(conversation.id)!.status).toBe('idle');

    await service.sendMessage(conversation.id, text('Again'));
    const history = runner.started[1]!.messages;
    expect(history[1]!.content.map((b) => b.type)).toEqual([
      'text',
      'tool_use',
      'tool_result',
      'text',
    ]);
  });

  it('records every decision, and allow-always reaches the next run', async () => {
    const { conversation, runId } = await started();
    runner.send(runId, toolUse('t1'));
    runner.send(runId, toolCall('t1'));
    service.decide(conversation.id, 't1', 'allow-always');
    runner.send(runId, toolResult('t1'));
    runner.send(runId, done());
    const second = await started();
    runner.send(second.runId, toolUse('t2', 'fs__delete'));
    runner.send(second.runId, { ...toolCall('t2'), toolName: 'delete' } as RunEventPayload);
    service.decide(second.conversation.id, 't2', 'deny');
    const approvals = new ToolApprovalRepository(db);
    expect(approvals.listByConversation(conversation.id)).toMatchObject([
      { agentId: 'a1', toolUseId: 't1', toolName: 'write_file', decision: 'allow-always' },
    ]);
    expect(approvals.listByConversation(second.conversation.id)[0]).toMatchObject({
      decision: 'deny',
    });
    expect(runner.started[1]!.alwaysAllowed).toEqual(['filesystem:write_file']);
  });

  it('does not wait for calls that need no approval', async () => {
    const { conversation, runId } = await started();
    runner.send(runId, toolUse('t1', 'fs__read_file'));
    runner.send(runId, toolCall('t1', false));
    expect(conversations.get(conversation.id)!.status).toBe('running');
  });

  it('cancel while waiting ends the reply cancelled and clears the pending approval', async () => {
    const { conversation, runId, reply } = await started();
    runner.send(runId, toolUse('t1'));
    runner.send(runId, toolCall('t1'));
    service.cancel(conversation.id);
    expect(runner.cancelled).toEqual([runId]);
    runner.send(runId, usage({ estimated: true }));
    runner.send(runId, done('cancelled'));
    expect(messages.get(reply.id)!.status).toBe('cancelled');
    expect(conversations.get(conversation.id)!.status).toBe('idle');
    expect(of('conversation.updated').at(-1)).toMatchObject({ pendingApproval: null });
    expect(() => service.decide(conversation.id, 't1', 'allow')).toThrow();
  });

  it('refuses to send when a server secret is missing, before writing anything', async () => {
    const repo = new ToolServerRepository(db);
    repo.create({
      id: 'gh',
      name: 'GitHub',
      transport: 'stdio',
      command: 'gh-mcp',
      args: [],
      env: { TOKEN: { secretRef: 'toolServer:gh:env:TOKEN' } },
      url: null,
      headers: {},
      enabled: true,
    });
    agents.update('a1', { toolServerIds: ['gh'] });
    const conversation = service.create('a1');
    await expect(service.sendMessage(conversation.id, text('hi'))).rejects.toMatchObject({
      code: 'secret_missing',
    });
    expect(messages.all(conversation.id)).toEqual([]);
  });
});

describe('ConversationService: titles', () => {
  it('titles a new conversation from its first message, then from the title model', async () => {
    title.generate.mockResolvedValueOnce('Greetings exchange');
    const { conversation, runId, reply } = await started('a1', '  Hello   there,\nsecond line');
    expect(conversations.get(conversation.id)!.title).toBe('Hello there,');
    runner.send(runId, { type: 'run.text_delta', text: 'Hi!' });
    runner.send(runId, done());
    await vi.waitFor(() =>
      expect(conversations.get(conversation.id)!.title).toBe('Greetings exchange'),
    );
    expect(title.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.id,
        user: expect.objectContaining({ role: 'user' }),
        reply: expect.objectContaining({ id: reply.id, content: text('Hi!') }),
      }),
    );
    expect(of('conversation.updated').at(-1)!.conversation.title).toBe('Greetings exchange');

    await service.sendMessage(conversation.id, text('next'));
    runner.send(runner.lastRunId(), done());
    await Promise.resolve();
    expect(title.generate).toHaveBeenCalledTimes(1);
  });

  it('a rename made while the title is generated wins; errors do not title', async () => {
    let resolve!: (t: string) => void;
    title.generate.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { conversation, runId } = await started();
    runner.send(runId, done());
    service.rename(conversation.id, 'Mine');
    resolve('Generated');
    await Promise.resolve();
    await Promise.resolve();
    expect(conversations.get(conversation.id)!.title).toBe('Mine');

    const other = await started();
    runner.send(other.runId, {
      type: 'run.error',
      code: 'auth_failed',
      message: '401',
      retryable: false,
    });
    expect(title.generate).toHaveBeenCalledTimes(1);
  });
});

describe('TitleService', () => {
  const reqFor = async (agentId: string) => {
    const agent = agents.require(agentId);
    const { connection } = connections.require(agent.connectionId);
    const user = {
      ...messages.insert(
        conversations.create(agentId).id,
        'user',
        text('Plan a trip to Lisbon'),
        'complete',
      ),
    };
    const reply = messages.insert(
      user.conversationId,
      'assistant',
      text('Sure, here is a plan'),
      'complete',
    );
    return { conversationId: user.conversationId, agent, connection, user, reply };
  };

  it('runs the cheap model once, cleans its answer and records its usage without a message', async () => {
    const titles = new TitleService({
      runner: runner as unknown as RunnerPort,
      usage: usageRepo,
      secretFor: secretFor as never,
    });
    const req = await reqFor('a1');
    const pending = titles.generate(req);
    await vi.waitFor(() => expect(runner.started).toHaveLength(1));
    const run = runner.started[0]!;
    expect(run.agent.model).toBe('claude-haiku-4-5');
    expect(run.agent.params).toMatchObject({ maxTokens: 24 });
    expect(run.secret).toBe('sk-test');
    expect(run.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Lisbon'),
    });
    runner.send(run.runId!, { type: 'run.text_delta', text: '"Lisbon trip plan."' });
    runner.send(run.runId!, usage({ outputTokens: 4 }));
    runner.send(run.runId!, done());
    expect(await pending).toBe('Lisbon trip plan');
    expect(usageRepo.listByConversation(req.conversationId)).toEqual([
      expect.objectContaining({ messageId: null, model: 'claude-haiku-4-5', outputTokens: 4 }),
    ]);
  });

  it('gives no title for CLI harnesses, failed runs or a runner that never answers', async () => {
    const titles = new TitleService({
      runner: runner as unknown as RunnerPort,
      usage: usageRepo,
      secretFor: secretFor as never,
    });
    expect(await titles.generate(await reqFor('a-cli'))).toBeNull();
    expect(runner.started).toEqual([]);

    const failing = titles.generate(await reqFor('a1'));
    await vi.waitFor(() => expect(runner.started).toHaveLength(1));
    runner.send(runner.lastRunId(), {
      type: 'run.error',
      code: 'provider_error',
      message: 'no model',
      retryable: false,
    });
    expect(await failing).toBeNull();

    const silent = titles.generate(await reqFor('a1'));
    await vi.waitFor(() => expect(runner.started).toHaveLength(2));
    vi.advanceTimersByTime(30_000);
    expect(await silent).toBeNull();
    expect(runner.cancelled).toEqual([runner.lastRunId()]);
  });
});
