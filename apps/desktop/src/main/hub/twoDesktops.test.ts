import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, RunEvent, RunEventPayload, UserContent } from '@comitiva/contract';
import type { RunStartPayload } from '@comitiva/runner';
import type { Backend, BackendEvent } from '../../renderer/src/backend/Backend';
import type { HubExecutor, HubTransport } from '../../renderer/src/backend/hub/HubTransport';
import { RemoteBackend } from '../../renderer/src/backend/RemoteBackend';
import { Database } from '../db/Database';
import { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import { HubLocalRepository } from '../db/repositories/HubLocalRepository';
import { PricingRepository } from '../db/repositories/PricingRepository';
import type { RunnerPort } from '../services/chat/RunEngine';
import { FakeHub } from '../testing/FakeHub';
import { MemorySecrets } from '../testing/MemorySecrets';
import { Pricing } from '../usage/Pricing';
import { HubRunService } from './HubRunService';
import { HubService, type HubSettings } from './HubService';

/** Records run requests; the test plays each desktop's runner with `send`. */
class FakeRunner extends EventEmitter<{ 'run.event': [RunEvent & { receivedAt: number }] }> {
  readonly started: RunStartPayload[] = [];
  readonly cancelled: string[] = [];
  readonly approved: string[] = [];
  startRun(payload: RunStartPayload) {
    this.started.push(payload);
    return { runId: payload.runId! };
  }
  cancelRun(runId: string) {
    this.cancelled.push(runId);
  }
  approve(runId: string, toolUseId: string) {
    this.approved.push(`${runId}:${toolUseId}`);
  }
  send(event: RunEventPayload, runId = this.started.at(-1)!.runId!) {
    this.emit('run.event', { ...event, runId, receivedAt: Date.now() } as RunEvent & {
      receivedAt: number;
    });
  }
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * One desktop: its own database, secrets, runner, hub session and a
 * RemoteBackend over an in-process transport (in the app, the same calls go
 * through IPC to main).
 */
class Desktop {
  readonly db = Database.open(':memory:');
  readonly secrets = new MemorySecrets();
  readonly runner = new FakeRunner();
  readonly connections: ConnectionRepository;
  readonly local: HubLocalRepository;
  readonly hub: HubService;
  readonly runs: HubRunService;
  readonly events: BackendEvent[] = [];
  backend!: RemoteBackend;
  private settings: HubSettings = { url: null, user: null };

  constructor(
    readonly name: string,
    fake: FakeHub,
  ) {
    this.db.migrate(join(__dirname, '..', 'db', 'migrations'));
    this.connections = new ConnectionRepository(this.db);
    this.connections.create({
      id: `conn-${name}`,
      name: `${name}'s Anthropic`,
      provider: 'anthropic',
      config: { defaultModel: 'claude-haiku-4-5' },
      secretRef: `connection:conn-${name}`,
    });
    this.local = new HubLocalRepository(this.db);
    this.hub = new HubService({
      settings: { get: () => this.settings, set: (s) => (this.settings = s) },
      secrets: this.secrets,
      deviceName: `${name}'s laptop`,
      fetch: fake.fetch,
      WebSocketImpl: fake.WebSocket,
      log: () => {},
    });
    this.runs = new HubRunService({
      hub: this.hub,
      local: this.local,
      connections: this.connections,
      toolServers: { launchesFor: async () => [] },
      secrets: this.secrets,
      pricing: new Pricing(new PricingRepository(this.db)),
      attachments: { resolve: async (m) => [...m] },
      runner: this.runner as unknown as RunnerPort,
      secretFor: async () => 'sk-test',
      title: { generate: async () => null },
      workspacesDir: '/tmp/workspaces',
      timing: { publishMs: 5, heartbeatMs: 60_000, retryMs: 5 },
      log: () => {},
    });
  }

  get connectionId() {
    return `conn-${this.name}`;
  }

  open(workspaceId: string, workspaceName: string, role: 'owner' | 'admin' | 'member') {
    const hub = this.hub;
    const runs = this.runs;
    const local = this.local;
    const transport: HubTransport = {
      request: (method, path, options = {}) =>
        hub.request({ method, path, ...options }) as Promise<never>,
      subscribe: async (channel) => hub.subscribe(channel),
      unsubscribe: async (channel) => hub.unsubscribe(channel),
      onEvent: (handler) => {
        hub.on('event', handler);
        return () => hub.off('event', handler);
      },
      onPresence: (handler) => {
        hub.on('presence', handler);
        return () => hub.off('presence', handler);
      },
    };
    const executor: HubExecutor = {
      send: (id, content) => runs.send(id, content),
      retry: (id) => runs.retry(id),
      cancel: (id) => runs.cancel(id),
      decide: async (id, toolUseId, decision) => runs.decide(id, toolUseId, decision),
      links: async (ws) => local.links(ws),
      setLink: async (link) => local.setLink(link),
      secretNames: async () => [],
      setSecrets: async () => [],
      attachmentUrl: (id) => `comitiva-hub-attachment://file/${id}`,
    };
    const personal = {
      connections: {
        list: async () =>
          this.connections
            .list()
            .map((r) => ({ connection: r.connection, hasSecret: true, lastTest: null })),
      },
      toolServers: { list: async () => [] },
      onEvent: () => () => {},
    } as unknown as Backend;
    this.backend = new RemoteBackend({
      local: personal,
      transport,
      executor,
      workspace: { id: workspaceId, name: workspaceName, role, userId: hub.signedInUser()!.id },
    });
    this.backend.onEvent((e) => this.events.push(e));
    return this.backend;
  }

  text(conversationId: string): string {
    return this.events
      .filter((e) => e.type === 'message.delta' && e.conversationId === conversationId)
      .map((e) => (e as { text: string }).text)
      .join('');
  }

  finalReply(conversationId: string): Message | undefined {
    return this.events
      .filter(
        (e): e is Extract<BackendEvent, { type: 'message.updated' }> =>
          e.type === 'message.updated' &&
          e.message.conversationId === conversationId &&
          e.message.role === 'assistant' &&
          e.message.status !== 'streaming',
      )
      .at(-1)?.message;
  }

  close() {
    this.backend?.dispose();
    this.runs.shutdown();
    this.hub.close();
    this.db.close();
  }
}

let fake: FakeHub;
let ana: Desktop;
let bea: Desktop;
let workspaceId: string;

const hello: UserContent = [{ type: 'text', text: 'Summarize the plan' }];

beforeEach(async () => {
  fake = new FakeHub();
  ana = new Desktop('ana', fake);
  bea = new Desktop('bea', fake);
  for (const d of [ana, bea]) {
    await d.hub.init();
    await d.hub.configure(fake.url);
  }
  await ana.hub.register({ name: 'Ana', email: 'ana@example.com', password: 'long enough' });
  const ws = (await ana.hub.request({
    method: 'POST',
    path: '/api/v1/workspaces',
    body: { name: 'Research' },
  })) as { id: string };
  workspaceId = ws.id;
  const invitation = (await ana.hub.request({
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    body: { email: 'bea@example.com' },
  })) as { token: string };
  await bea.hub.register({
    name: 'Bea',
    email: 'bea@example.com',
    password: 'long enough',
    invitationToken: invitation.token,
  });
  ana.open(workspaceId, 'Research', 'owner');
  bea.open(workspaceId, 'Research', 'member');
  await until(() => ana.hub.status().realtime === 'connected', 'Ana online');
  await until(() => bea.hub.status().realtime === 'connected', 'Bea online');
});

afterEach(() => {
  ana.close();
  bea.close();
});

describe('two desktops in one workspace', () => {
  it('see each other online', async () => {
    await until(
      () =>
        ana.events.some(
          (e) => e.type === 'presence.updated' && e.members.some((m) => m.name === 'Bea'),
        ),
      'Ana to see Bea',
    );
    await until(
      () =>
        bea.events.some(
          (e) => e.type === 'presence.updated' && e.members.some((m) => m.name === 'Ana'),
        ),
      'Bea to see Ana',
    );
  });

  it("see each other's messages live, each run on its own desktop with its own connection", async () => {
    // Ana shares an agent and starts a conversation.
    const agent = await ana.backend.agents.create({
      name: 'Researcher',
      avatar: { color: 'indigo' },
      connectionId: ana.connectionId,
      role: 'Be brief.',
    });
    expect(agent.connectionId).toBe(ana.connectionId);
    const conversation = await ana.backend.conversations.create(agent.id);

    // Bea sees the agent, not yet linked to a connection of hers, and opens the conversation.
    const seen = (await bea.backend.agents.list()).find((a) => a.id === agent.id)!;
    expect(seen.connectionId).toBe('');
    const page = await bea.backend.messages.list(conversation.id);
    expect(page.messages).toEqual([]);
    await ana.backend.messages.list(conversation.id);

    // Ana sends: her runner runs it, and Bea sees the reply stream in.
    await ana.backend.messages.send(conversation.id, hello);
    expect(ana.runner.started).toHaveLength(1);
    expect(ana.runner.started[0]!.connection.id).toBe(ana.connectionId);
    expect(ana.runner.started[0]!.messages.map((m) => m.role)).toEqual(['user']);
    ana.runner.send({ type: 'run.text_delta', text: 'The plan ' });
    await until(() => bea.text(conversation.id) === 'The plan ', 'the first delta at Bea');
    ana.runner.send({ type: 'run.text_delta', text: 'has three steps.' });
    ana.runner.send({ type: 'run.usage', inputTokens: 20, outputTokens: 6, estimated: false });
    ana.runner.send({ type: 'run.done', stopReason: 'end_turn' });
    await until(
      () => bea.finalReply(conversation.id)?.status === 'complete',
      'the final reply at Bea',
    );
    expect(bea.text(conversation.id)).toBe('The plan has three steps.');
    expect(bea.finalReply(conversation.id)!.content).toEqual([
      { type: 'text', text: 'The plan has three steps.' },
    ]);
    // Ana's window got the same stream, from the hub.
    expect(ana.text(conversation.id)).toBe('The plan has three steps.');
    // The usage went to the hub, costed on Ana's desktop.
    expect(fake.lastUsage).toMatchObject({
      provider: 'anthropic',
      inputTokens: 20,
      outputTokens: 6,
    });

    // A page read now matches what was streamed.
    const after = await bea.backend.messages.list(conversation.id);
    expect(after.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);

    // Bea links the agent to her own connection and replies; Ana sees it.
    await expect(bea.backend.messages.send(conversation.id, hello)).rejects.toMatchObject({
      code: 'agent_not_linked',
    });
    await bea.backend.agents.update(agent.id, { connectionId: bea.connectionId });
    await bea.backend.messages.send(conversation.id, [{ type: 'text', text: 'And the risks?' }]);
    expect(bea.runner.started).toHaveLength(1);
    expect(bea.runner.started[0]!.connection.id).toBe(bea.connectionId);
    // Her runner gets the whole conversation so far.
    expect(bea.runner.started[0]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    bea.runner.send({ type: 'run.text_delta', text: 'Two risks.' });
    bea.runner.send({ type: 'run.done', stopReason: 'end_turn' });
    await until(
      () =>
        ana.events.some(
          (e) =>
            e.type === 'message.updated' &&
            e.message.content.some((b) => b.type === 'text' && b.text === 'Two risks.') &&
            e.message.status === 'complete',
        ),
      "Bea's reply at Ana",
    );
    // Neither desktop ran the other's turn.
    expect(ana.runner.started).toHaveLength(1);
  });

  it('keeps one run per conversation across desktops, and lets the other member stop it', async () => {
    const agent = await ana.backend.agents.create({
      name: 'Researcher',
      avatar: { color: 'indigo' },
      connectionId: ana.connectionId,
    });
    await bea.backend.agents.update(agent.id, { connectionId: bea.connectionId });
    const conversation = await ana.backend.conversations.create(agent.id);
    await ana.backend.messages.send(conversation.id, hello);

    await expect(bea.backend.messages.send(conversation.id, hello)).rejects.toMatchObject({
      code: 'conversation_busy',
    });
    await until(
      () => bea.events.some((e) => e.type === 'conversation.updated' && e.runner?.name === 'Ana'),
      "Bea to see that Ana's desktop runs it",
    );

    // Bea is not its runner nor an admin: the hub refuses her stop request.
    await expect(bea.backend.messages.cancel(conversation.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    // Ana (owner) asks from the hub side: her own desktop cancels.
    await ana.hub.request({
      method: 'POST',
      path: `/api/v1/conversations/${conversation.id}/cancel`,
    });
    await until(() => ana.runner.cancelled.length === 1, 'the cancel to reach Ana’s runner');
    ana.runner.send({ type: 'run.done', stopReason: 'cancelled' });
    await until(
      () => fake.conversations.get(conversation.id)!.status === 'idle',
      'the conversation to be free',
    );
    await bea.backend.messages.send(conversation.id, hello);
    expect(bea.runner.started).toHaveLength(1);
  });

  it('shows a pending approval to everyone, and only the running desktop answers it', async () => {
    const agent = await ana.backend.agents.create({
      name: 'Writer',
      avatar: { color: 'teal' },
      connectionId: ana.connectionId,
    });
    const conversation = await ana.backend.conversations.create(agent.id);
    await bea.backend.messages.list(conversation.id);
    await ana.backend.messages.send(conversation.id, hello);
    const toolUse = {
      type: 'tool_use' as const,
      id: 'toolu_1',
      toolServerId: 'filesystem',
      name: 'fs__write_file',
      input: { path: 'notes.md' },
    };
    ana.runner.send({ type: 'run.block', block: toolUse });
    ana.runner.send({
      type: 'run.tool_call',
      toolUseId: 'toolu_1',
      toolServerId: 'filesystem',
      toolName: 'write_file',
      input: { path: 'notes.md' },
      requiresApproval: true,
    });
    await until(
      () =>
        bea.events.some(
          (e) => e.type === 'conversation.updated' && e.pendingApproval?.toolUseId === 'toolu_1',
        ),
      'the pending call at Bea',
    );
    // Bea's desktop does not run it: it has nothing to answer.
    await expect(
      bea.backend.approvals.decide(conversation.id, 'toolu_1', 'allow'),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await ana.backend.approvals.decide(conversation.id, 'toolu_1', 'allow');
    expect(ana.runner.approved).toEqual([`${ana.runner.started[0]!.runId}:toolu_1`]);
    ana.runner.send({
      type: 'run.tool_result',
      toolUseId: 'toolu_1',
      output: [{ type: 'text', text: 'written' }],
      isError: false,
      durationMs: 3,
    });
    ana.runner.send({ type: 'run.done', stopReason: 'end_turn' });
    await until(() => bea.finalReply(conversation.id)?.status === 'complete', 'the reply at Bea');
    expect(bea.finalReply(conversation.id)!.content.map((b) => b.type)).toEqual([
      'tool_use',
      'tool_result',
    ]);
    expect(
      bea.events.some(
        (e) =>
          e.type === 'message.block' &&
          e.block.type === 'tool_result' &&
          e.block.toolUseId === 'toolu_1',
      ),
    ).toBe(true);
  });

  it('keeps the token out of the status, and forgets it on sign-out', async () => {
    const status = JSON.stringify(ana.hub.status());
    const token = await ana.secrets.get('hub:token');
    expect(token).toBeTruthy();
    expect(status).not.toContain(token!);
    await ana.hub.logout();
    expect(ana.hub.status().user).toBeNull();
    expect(await ana.secrets.get('hub:token')).toBeNull();
  });
});
