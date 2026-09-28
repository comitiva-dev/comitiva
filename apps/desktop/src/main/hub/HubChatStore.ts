import {
  AppError,
  HubConversationSummary,
  HubRunFinishResult,
  HubRunStartResult,
  SharedAgent,
  WorkspaceToolServer,
  type Agent,
  type AgentLink,
  type ApprovalDecision,
  type Block,
  type Connection,
  type HubRunEvent,
  type HubUsageInput,
  type Message,
  type PendingApproval,
  type RunToolCallEvent,
  type ToolServerLaunch,
} from '@comitiva/contract';
import type { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import type { HubLocalRepository } from '../db/repositories/HubLocalRepository';
import type { SecretStore } from '../secrets/SecretStore';
import type {
  ChatStore,
  RunOutcome,
  RunSession,
  RunTarget,
  RunUsage,
  Turn,
  TurnInput,
} from '../services/chat/ChatStore';
import { placeholderTitle } from '../services/TitleService';
import type { ToolServerService } from '../services/ToolServerService';
import type { Pricing } from '../usage/Pricing';
import type { HubAttachments } from './HubAttachments';
import type { HubClient } from './HubClient';
import type { HubService } from './HubService';

export interface HubChatStoreDeps {
  hub: Pick<HubService, 'client' | 'call' | 'subscribe' | 'unsubscribe' | 'on' | 'off'>;
  local: HubLocalRepository;
  connections: ConnectionRepository;
  toolServers: Pick<ToolServerService, 'launchesFor'>;
  secrets: SecretStore;
  pricing: Pick<Pricing, 'cost'>;
  attachments: Pick<HubAttachments, 'resolve'>;
  /** Someone asked this desktop to stop a run (`run.cancel_requested`), or the hub gave up on it. */
  onStop(conversationId: string): void;
  timing?: { publishMs?: number; heartbeatMs?: number; retryMs?: number };
  log?: (message: string) => void;
}

/** Where a workspace tool server's secret header is kept on this machine. */
export const hubHeaderRef = (toolServerId: string, name: string) =>
  `hubToolServer:${toolServerId}:header:${name}`;

/**
 * Workspace conversations: the hub is their store (ADR 0017). A turn takes
 * the conversation's run lock at the hub, the runner's events are published
 * in numbered batches (every 100 ms), and the finish carries the final
 * content and the usage, costed here with this desktop's prices (ADR 0011).
 * This window sees the stream the way every other member does: from the
 * hub's broadcasts.
 */
export class HubChatStore implements ChatStore {
  readonly publishMs: number;
  readonly heartbeatMs: number;
  readonly retryMs: number;

  constructor(readonly deps: HubChatStoreDeps) {
    this.publishMs = deps.timing?.publishMs ?? 100;
    this.heartbeatMs = deps.timing?.heartbeatMs ?? 10_000;
    this.retryMs = deps.timing?.retryMs ?? 250;
  }

  client(): HubClient {
    return this.deps.hub.client();
  }

  async target(conversationId: string): Promise<RunTarget> {
    const summary = HubConversationSummary.parse(
      await this.deps.hub.call(() =>
        this.client().request('GET', `/api/v1/conversations/${conversationId}`),
      ),
    );
    const shared = SharedAgent.parse(
      await this.deps.hub.call(() =>
        this.client().request('GET', `/api/v1/agents/${summary.conversation.agentId}`),
      ),
    );
    const link = this.deps.local.link(shared.id);
    const connection = link?.connectionId ? this.connection(link.connectionId) : null;
    if (!link || !connection) {
      throw new AppError('agent_not_linked', `Choose a connection to run ${shared.name}`);
    }
    const agent = runnerAgent(shared, link, connection);
    return {
      agent,
      connection,
      launches: async () => [
        ...(await this.deps.toolServers.launchesFor({
          ...agent,
          toolServerIds: link.toolServerIds,
        })),
        ...(await this.workspaceLaunches(shared)),
      ],
    };
  }

  alwaysAllowed(agentId: string): string[] {
    return this.deps.local.alwaysAllowed(agentId);
  }

  harnessSession(conversationId: string, connectionId: string): string | undefined {
    return this.deps.local.harnessSession(conversationId, connectionId);
  }

  setHarnessSession(conversationId: string, sessionId: string, connectionId: string): void {
    this.deps.local.setHarnessSession(conversationId, sessionId, connectionId);
  }

  resolveHistory(messages: Message[]): Promise<Message[]> {
    return this.deps.attachments.resolve(messages);
  }

  async beginTurn({ conversationId, runId, content, target }: TurnInput): Promise<Turn> {
    const started = HubRunStartResult.parse(
      await this.deps.hub.call(() =>
        this.client().request('POST', `/api/v1/conversations/${conversationId}/runs`, {
          body: content === null ? { runId } : { runId, content },
        }),
      ),
    );
    const history = started.history;
    return {
      reply: started.reply,
      history,
      session: new HubRunSession(this, target, conversationId, runId, started),
    };
  }

  /** What a run's usage cost, with this desktop's prices; the hub stores it as is. */
  usageInput(connection: Connection, u: RunUsage): HubUsageInput {
    const cost = this.deps.pricing.cost(
      connection.provider,
      u.model,
      {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
      },
      u.reportedCostUsd,
    );
    return {
      provider: connection.provider,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      estimated: u.estimated,
      estimatedCostUsd: cost.usd,
      costSource: cost.source,
      // A cost the harness reported is its own measurement, not arithmetic over estimates.
      costEstimated: cost.source !== 'harness' && u.estimated && cost.usd !== null,
      latencyMs: u.latencyMs,
    };
  }

  log(message: string): void {
    (this.deps.log ?? ((m: string) => console.warn(`HubChatStore: ${m}`)))(message);
  }

  private connection(id: string): Connection | null {
    try {
      return this.deps.connections.require(id).connection;
    } catch {
      return null;
    }
  }

  /** The agent's workspace http servers, with this member's secret header values. */
  private async workspaceLaunches(shared: SharedAgent): Promise<ToolServerLaunch[]> {
    if (shared.toolServerIds.length === 0) return [];
    const servers = WorkspaceToolServer.array().parse(
      await this.deps.hub.call(() =>
        this.client().request('GET', `/api/v1/workspaces/${shared.workspaceId}/tool-servers`),
      ),
    );
    const launches: ToolServerLaunch[] = [];
    for (const id of shared.toolServerIds) {
      const server = servers.find((s) => s.id === id);
      if (!server?.enabled) continue;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(server.headers)) {
        if ('value' in value) {
          headers[name] = value.value;
          continue;
        }
        const secret = await this.deps.secrets.get(hubHeaderRef(server.id, name));
        if (secret === null) {
          throw new AppError('secret_missing', `Enter your ${name} for ${server.name} in Tools`);
        }
        headers[name] = secret;
      }
      launches.push({
        id: server.id,
        name: server.name,
        transport: 'http',
        url: server.url,
        headers,
      });
    }
    return launches;
  }
}

/** The shared agent as the runner sees it on this desktop: the member's connection, folders and tools. */
export function runnerAgent(shared: SharedAgent, link: AgentLink, connection: Connection): Agent {
  return {
    id: shared.id,
    name: shared.name,
    avatar: shared.avatar,
    connectionId: connection.id,
    // The shared model names a model of the shared provider; another provider uses its own default.
    model: connection.provider === shared.provider ? shared.model : null,
    role: shared.role,
    params: shared.params,
    toolServerIds: [...shared.toolServerIds, ...link.toolServerIds],
    roots: link.roots,
    permissionPolicy: shared.permissionPolicy,
    fallbackConnectionIds: [],
    tags: shared.tags,
    createdAt: shared.createdAt,
    updatedAt: shared.updatedAt,
  };
}

const RETRYABLE = new Set(['hub_unreachable', 'rate_limited', 'internal']);

/**
 * One turn published to the hub. Output is queued and sent in numbered
 * batches, one request at a time, retried when the hub is briefly away (the
 * batch number makes a retry harmless). A heartbeat keeps the lease while
 * the run is quiet (a long tool call, an approval).
 */
class HubRunSession implements RunSession {
  private queue: HubRunEvent[] = [];
  private batch = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastSent = Date.now();
  private expired = false;
  private closed = false;
  private readonly channel: string;
  private readonly onEvent: (channel: string, event: { type: string; runId?: string }) => void;

  constructor(
    private readonly store: HubChatStore,
    private readonly target: RunTarget,
    private readonly conversationId: string,
    private readonly runId: string,
    private readonly started: HubRunStartResult,
  ) {
    this.channel = `private-conversation.${conversationId}`;
    this.onEvent = (channel, event) => {
      if (
        channel === this.channel &&
        event.type === 'run.cancel_requested' &&
        event.runId === runId
      ) {
        store.deps.onStop(conversationId);
      }
    };
    store.deps.hub.on('event', this.onEvent as never);
    store.deps.hub.subscribe(this.channel);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSent >= store.heartbeatMs / 2) {
        this.enqueue(() => this.post(`/api/v1/runs/${runId}/heartbeat`, undefined));
      }
    }, store.heartbeatMs);
  }

  text(delta: string): void {
    const last = this.queue.at(-1);
    if (last?.type === 'run.text_delta') last.text += delta;
    else
      this.queue.push({ type: 'run.text_delta', runId: this.runId, text: delta, ts: Date.now() });
    this.schedule();
  }

  block(block: Block): void {
    this.queue.push(
      block.type === 'tool_result'
        ? {
            type: 'run.tool_result',
            runId: this.runId,
            toolUseId: block.toolUseId,
            output: block.content,
            isError: block.isError,
            durationMs: block.durationMs ?? 0,
          }
        : { type: 'run.block', runId: this.runId, block },
    );
    this.schedule();
  }

  toolCall(event: RunToolCallEvent): void {
    this.queue.push({
      type: 'run.tool_call',
      runId: this.runId,
      toolUseId: event.toolUseId,
      toolServerId: event.toolServerId,
      toolName: event.toolName,
      input: event.input,
      requiresApproval: event.requiresApproval,
    });
    this.schedule();
  }

  /** Everyone should see the pending call at once. */
  awaitingApproval(): void {
    this.flush();
  }

  decided(pending: PendingApproval, decision: ApprovalDecision): Promise<void> {
    if (decision === 'allow-always') {
      this.store.deps.local.allowAlways(
        this.target.agent.id,
        pending.toolServerId,
        pending.toolName,
      );
    }
    this.flush();
    return this.enqueue(() =>
      this.post(`/api/v1/runs/${this.runId}/approvals`, { toolUseId: pending.toolUseId, decision }),
    );
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    const batch = ++this.batch;
    void this.enqueue(() => this.post(`/api/v1/runs/${this.runId}/events`, { batch, events }));
  }

  async finish(outcome: RunOutcome): Promise<Message | null> {
    this.flush();
    this.stopTimers();
    await this.chain;
    try {
      if (this.expired) return null;
      const result = await this.post(`/api/v1/runs/${this.runId}/finish`, {
        status: outcome.status,
        stopReason: outcome.stopReason,
        content: outcome.blocks,
        error: outcome.error,
        usage: outcome.usage ? this.store.usageInput(this.target.connection, outcome.usage) : null,
      });
      return HubRunFinishResult.parse(result).message;
    } catch (err) {
      this.store.log(`finishing run ${this.runId} failed: ${AppError.from(err).message}`);
      return null;
    } finally {
      this.close();
    }
  }

  close(): void {
    this.stopTimers();
    if (this.closed) return;
    this.closed = true;
    this.store.deps.hub.off('event', this.onEvent as never);
    this.store.deps.hub.unsubscribe(this.channel);
  }

  /** The first reply names the conversation; the hub keeps a rename made meanwhile. */
  titleCandidate(reply: Message): { user: Message; placeholder: string | null } | null {
    if (this.started.history.some((m) => m.role === 'assistant' && m.status === 'complete')) {
      return null;
    }
    const user = [
      ...this.started.history,
      ...(this.started.userMessage ? [this.started.userMessage] : []),
    ].find((m) => m.role === 'user');
    if (!user || reply.status !== 'complete') return null;
    return { user, placeholder: placeholderTitle(user.content) };
  }

  async applyTitle(title: string): Promise<void> {
    await this.store.deps.hub
      .call(() =>
        this.store.client().request('PATCH', `/api/v1/conversations/${this.conversationId}`, {
          body: { title, titleSource: 'auto' },
        }),
      )
      .catch((err: unknown) => this.store.log(`title not saved: ${AppError.from(err).message}`));
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), this.store.publishMs);
  }

  private stopTimers(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** One request at a time, in order; a failure is logged and does not block the next. */
  private enqueue<T>(fn: () => Promise<T>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.expired) return;
      try {
        await fn();
      } catch (err) {
        const error = AppError.from(err);
        if (error.code === 'run_expired') {
          this.expired = true;
          this.store.deps.onStop(this.conversationId);
        }
        this.store.log(`publishing run ${this.runId} failed: ${error.message}`);
      }
    });
    this.chain = next;
    return next;
  }

  /** A POST retried a few times while the hub is briefly away. */
  private async post(path: string, body: unknown): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.store
          .client()
          .request('POST', path, body === undefined ? {} : { body });
        this.lastSent = Date.now();
        return result;
      } catch (err) {
        const error = AppError.from(err);
        if (!RETRYABLE.has(error.code) || attempt >= 4) throw error;
        await new Promise((r) => setTimeout(r, this.store.retryMs * 2 ** attempt));
        attempt += 1;
      }
    }
  }
}
