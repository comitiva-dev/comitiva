import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';
import {
  AppError,
  appendText,
  type Agent,
  type AppErrorShape,
  type Block,
  type Connection,
  type Conversation,
  type ConversationSummary,
  type IpcEventPayload,
  type Message,
  type MessagePage,
  type MessageStatus,
  type RunEvent,
  type RunUsageEvent,
  type UserContent,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import type { Database } from '../db/Database';
import type { AgentRepository } from '../db/repositories/AgentRepository';
import type { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import type { ConversationRepository } from '../db/repositories/ConversationRepository';
import type { MessageRepository } from '../db/repositories/MessageRepository';
import type { UsageRepository } from '../db/repositories/UsageRepository';
import { placeholderTitle, type TitleService } from './TitleService';
import { resolveWorkingDirectory } from './workingDirectory';

export type RunnerPort = Pick<RunnerClient, 'startRun' | 'cancelRun' | 'on' | 'off'>;

export interface ConversationEvents {
  'conversation.updated': [IpcEventPayload<'conversation.updated'>];
  'message.updated': [IpcEventPayload<'message.updated'>];
  'message.delta': [IpcEventPayload<'message.delta'>];
  'message.block': [IpcEventPayload<'message.block'>];
}

export interface ConversationServiceDeps {
  db: Database;
  conversations: ConversationRepository;
  messages: MessageRepository;
  usage: UsageRepository;
  agents: AgentRepository;
  connections: ConnectionRepository;
  /** The run's key, read per request (ConnectionService.secretFor); throws secret_missing. */
  secretFor(connection: Connection): Promise<string | undefined>;
  runner: RunnerPort;
  title: TitleService;
  /** `<userData>/workspaces`: default working directory of CLI harness conversations. */
  workspacesDir: string;
  timing?: { uiFlushMs?: number; dbFlushMs?: number; cancelGraceMs?: number };
}

/** Everything a run needs, resolved before anything is persisted. */
interface RunContext {
  agent: Agent;
  connection: Connection;
  model: string;
  secret: string | undefined;
}

/** One active run: the streaming reply lives here until it is final. */
interface LiveRun extends RunContext {
  runId: string;
  conversationId: string;
  messageId: string;
  /** Authoritative content of the streaming reply. */
  blocks: Block[];
  /** Text in `blocks` not yet sent to the UI. */
  pendingText: string;
  uiTimer: NodeJS.Timeout | undefined;
  dbTimer: NodeJS.Timeout | undefined;
  cancelTimer: NodeJS.Timeout | undefined;
  usage: RunUsageEvent | undefined;
  startedAt: number;
}

/**
 * Conversations and their runs. Every conversation runs on its own (no
 * global queue); a conversation runs at most one reply at a time.
 *
 * Streaming: text deltas are coalesced to the UI at most once per frame
 * (16 ms) and checkpointed to SQLite about every 250 ms; the final state,
 * the usage record and the conversation status are written in one
 * transaction on the run's terminal event. Events go out as
 * `message.updated` snapshots plus `message.delta` / `message.block`, all
 * numbered by one `rev` per conversation, so a list fetched mid-stream lines
 * up with the stream (ADR 0008).
 */
export class ConversationService extends EventEmitter<ConversationEvents> {
  /** Conversations with a run starting or streaming: the double-send guard. */
  private readonly busy = new Set<string>();
  private readonly live = new Map<string, LiveRun>();
  private readonly byRun = new Map<string, LiveRun>();
  /** Event revision per conversation: +1 on every message event; pages carry it (ADR 0008). */
  private readonly revs = new Map<string, number>();
  private closed = false;
  private readonly uiFlushMs: number;
  private readonly dbFlushMs: number;
  private readonly cancelGraceMs: number;

  constructor(private readonly deps: ConversationServiceDeps) {
    super();
    this.uiFlushMs = deps.timing?.uiFlushMs ?? 16;
    this.dbFlushMs = deps.timing?.dbFlushMs ?? 250;
    this.cancelGraceMs = deps.timing?.cancelGraceMs ?? 10_000;
    deps.runner.on('run.event', this.onRunEvent);
  }

  // ------------------------------------------------------------ conversations

  list(filter: { agentId?: string | undefined; archived: boolean }): ConversationSummary[] {
    return this.deps.conversations.list(filter);
  }

  create(agentId: string): Conversation {
    this.deps.agents.require(agentId);
    return this.deps.conversations.create(agentId);
  }

  rename(id: string, title: string): Conversation {
    return this.updated(this.deps.conversations.rename(id, title));
  }

  archive(id: string, archived: boolean): Conversation {
    return this.updated(this.deps.conversations.setArchived(id, archived));
  }

  markRead(id: string): void {
    this.deps.conversations.markRead(id);
  }

  /** At boot: whatever was streaming when the app last stopped ends in `error { interrupted }`. */
  recover(): void {
    this.deps.db.transaction(() => {
      this.deps.messages.recoverInterrupted();
      this.deps.conversations.recoverInterrupted();
    });
  }

  // ----------------------------------------------------------------- messages

  /**
   * A page of messages at the conversation's current `rev`. For a
   * conversation streaming right now, pending text is flushed first and the
   * reply carries its live content, so the page is exactly the state at `rev`.
   */
  listMessages(input: {
    conversationId: string;
    beforeSeq?: number | undefined;
    limit: number;
  }): MessagePage {
    const { conversationId } = input;
    this.deps.conversations.require(conversationId);
    const page = this.deps.messages.page(conversationId, input);
    const run = this.live.get(conversationId);
    if (run) this.flushUi(run);
    return {
      hasMore: page.hasMore,
      messages: run
        ? page.messages.map((m) =>
            m.id === run.messageId ? { ...m, status: 'streaming', content: [...run.blocks] } : m,
          )
        : page.messages,
      rev: this.revs.get(conversationId) ?? 0,
    };
  }

  /**
   * Persists the user message and an empty reply, then starts the run.
   * Refusals (busy, connection disabled, no model, no key) throw before
   * anything is written; run failures end the reply in `error`.
   */
  async sendMessage(conversationId: string, content: UserContent): Promise<void> {
    this.reserve(conversationId);
    try {
      const conversation = this.deps.conversations.require(conversationId);
      const ctx = await this.prepare(conversation);
      const now = new Date().toISOString();
      const { user, reply, updated } = this.deps.db.transaction(() => {
        const user = this.deps.messages.insert(conversationId, 'user', content, 'complete', now);
        const reply = this.deps.messages.insert(conversationId, 'assistant', [], 'streaming', now);
        if (conversation.title === null) {
          const title = placeholderTitle(content);
          if (title) this.deps.conversations.rename(conversationId, title);
        }
        this.deps.conversations.setStatus(conversationId, 'running');
        return { user, reply, updated: this.deps.conversations.touch(conversationId, now) };
      });
      this.messageUpdated(user);
      this.messageUpdated(reply);
      this.updated(updated);
      this.start(ctx, reply);
    } catch (err) {
      this.busy.delete(conversationId);
      throw err;
    }
  }

  /** Runs the last reply again when it ended in `error`, in the same message. */
  async retryLast(conversationId: string): Promise<void> {
    this.reserve(conversationId);
    try {
      const conversation = this.deps.conversations.require(conversationId);
      const last = this.deps.messages.last(conversationId);
      if (!last || last.role !== 'assistant' || last.status !== 'error') {
        throw new AppError('invalid_request', 'The last reply did not fail');
      }
      const ctx = await this.prepare(conversation);
      const { reply, updated } = this.deps.db.transaction(() => {
        const reply = this.deps.messages.reset(last.id);
        this.deps.conversations.setStatus(conversationId, 'running');
        return { reply, updated: this.deps.conversations.touch(conversationId) };
      });
      this.messageUpdated(reply);
      this.updated(updated);
      this.start(ctx, reply);
    } catch (err) {
      this.busy.delete(conversationId);
      throw err;
    }
  }

  /**
   * Asks the runner to cancel; the run ends with its usage and
   * `done(cancelled)`, which leaves the reply `cancelled` (partial content
   * kept). If the runner never answers, the reply is finalized locally after
   * a grace period. A no-op when nothing is running.
   */
  cancel(conversationId: string): void {
    const run = this.live.get(conversationId);
    if (!run || run.cancelTimer) return;
    this.deps.runner.cancelRun(run.runId);
    run.cancelTimer = setTimeout(
      () => this.finish(run, 'cancelled', null, Date.now()),
      this.cancelGraceMs,
    );
  }

  /** Before an agent (and, by cascade, its conversations) is deleted: stop its runs, write nothing. */
  forgetAgent(agentId: string): void {
    for (const run of [...this.live.values()]) {
      if (run.agent.id !== agentId) continue;
      this.deps.runner.cancelRun(run.runId);
      this.drop(run);
    }
  }

  /** Before quitting: every active run is cancelled and finalized as `cancelled` now. */
  shutdown(): void {
    this.closed = true;
    for (const run of [...this.live.values()]) {
      this.deps.runner.cancelRun(run.runId);
      this.finish(run, 'cancelled', null, Date.now());
    }
    this.deps.runner.off('run.event', this.onRunEvent);
  }

  // ------------------------------------------------------------------ runs

  private reserve(conversationId: string): void {
    if (this.closed) throw new AppError('runner_unavailable', 'The app is closing');
    if (this.busy.has(conversationId)) {
      throw new AppError('conversation_busy', 'This conversation is already running');
    }
    this.busy.add(conversationId);
  }

  private async prepare(conversation: Conversation): Promise<RunContext> {
    const agent = this.deps.agents.require(conversation.agentId);
    const { connection } = this.deps.connections.require(agent.connectionId);
    if (!connection.enabled) {
      throw new AppError('connection_disabled', `Connection ${connection.name} is disabled`);
    }
    const model = agent.model ?? connection.config.defaultModel ?? '';
    if (!model && connection.kind === 'api') {
      throw new AppError('model_required', `Agent ${agent.name} has no model`);
    }
    const secret = await this.deps.secretFor(connection);
    return { agent, connection, model, secret };
  }

  private start(ctx: RunContext, reply: Message): void {
    const { agent, connection, secret } = ctx;
    const conversationId = reply.conversationId;
    const history = buildHistory(
      this.deps.messages.all(conversationId).filter((m) => m.seq < reply.seq),
    );
    const run: LiveRun = {
      ...ctx,
      runId: ulid(),
      conversationId,
      messageId: reply.id,
      blocks: [],
      pendingText: '',
      uiTimer: undefined,
      dbTimer: undefined,
      cancelTimer: undefined,
      usage: undefined,
      startedAt: Date.now(),
    };
    // Registered before the request goes out: a failed start comes back as run.error.
    this.live.set(conversationId, run);
    this.byRun.set(run.runId, run);
    const harnessSessionId = this.deps.conversations.harnessSession(conversationId, connection.id);
    const workingDirectory = resolveWorkingDirectory(
      connection,
      conversationId,
      this.deps.workspacesDir,
    );
    this.deps.runner.startRun({
      runId: run.runId,
      conversationId,
      agent,
      connection,
      messages: history,
      ...(secret !== undefined ? { secret } : {}),
      ...(harnessSessionId !== undefined ? { harnessSessionId } : {}),
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    });
  }

  private readonly onRunEvent = (e: RunEvent & { receivedAt: number }): void => {
    const run = this.byRun.get(e.runId);
    if (!run) return; // title runs, or a run already finalized
    try {
      this.handle(run, e);
    } catch (err) {
      // A listener must not throw into the runner client's stdout handler.
      console.error('ConversationService: failed to handle', e.type, AppError.from(err).message);
    }
  };

  private handle(run: LiveRun, e: RunEvent & { receivedAt: number }): void {
    switch (e.type) {
      case 'run.session':
        // Persisted at once, so a crash mid-turn still resumes the harness session.
        this.deps.conversations.setHarnessSession(
          run.conversationId,
          e.harnessSessionId,
          run.connection.id,
        );
        return;
      case 'run.text_delta':
        run.blocks = appendText(run.blocks, e.text);
        run.pendingText += e.text;
        run.uiTimer ??= setTimeout(() => this.flushUi(run), this.uiFlushMs);
        this.scheduleDb(run);
        return;
      case 'run.block':
        this.flushUi(run); // pending text goes out before the block
        run.blocks = [...run.blocks, e.block];
        this.emit('message.block', {
          conversationId: run.conversationId,
          messageId: run.messageId,
          rev: this.nextRev(run.conversationId),
          block: e.block,
        });
        this.scheduleDb(run);
        return;
      case 'run.usage':
        run.usage = e; // written with the terminal event: one record per run
        return;
      case 'run.tool_call':
      case 'run.tool_result':
        return; // Phase 5
      case 'run.done':
        this.finish(
          run,
          e.stopReason === 'cancelled' ? 'cancelled' : 'complete',
          null,
          e.receivedAt,
        );
        return;
      case 'run.error':
        this.finish(
          run,
          'error',
          { code: e.code, message: e.message, retryable: e.retryable },
          e.receivedAt,
        );
        return;
    }
  }

  private flushUi(run: LiveRun): void {
    clearTimeout(run.uiTimer);
    run.uiTimer = undefined;
    if (!run.pendingText) return;
    const text = run.pendingText;
    run.pendingText = '';
    this.emit('message.delta', {
      conversationId: run.conversationId,
      messageId: run.messageId,
      rev: this.nextRev(run.conversationId),
      text,
    });
  }

  private scheduleDb(run: LiveRun): void {
    run.dbTimer ??= setTimeout(() => {
      run.dbTimer = undefined;
      try {
        this.deps.messages.setContent(run.messageId, run.blocks);
      } catch (err) {
        console.error('ConversationService: checkpoint failed', AppError.from(err).message);
      }
    }, this.dbFlushMs);
  }

  private finish(
    run: LiveRun,
    status: Extract<MessageStatus, 'complete' | 'cancelled' | 'error'>,
    error: AppErrorShape | null,
    at: number,
  ): void {
    if (this.byRun.get(run.runId) !== run) return;
    this.flushUi(run);
    this.drop(run);
    const { conversations, messages, usage } = this.deps;
    const { message, conversation } = this.deps.db.transaction(() => {
      const message = messages.finish(run.messageId, status, run.blocks, error);
      if (run.usage) {
        const u = run.usage;
        usage.insert({
          connectionId: run.connection.id,
          agentId: run.agent.id,
          conversationId: run.conversationId,
          messageId: run.messageId,
          model: run.model || 'default',
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens ?? null,
          cacheWriteTokens: u.cacheWriteTokens ?? null,
          estimated: u.estimated,
          estimatedCostUsd: null, // Phase 6
          latencyMs: Math.max(0, Math.round(at - run.startedAt)),
        });
      }
      conversations.setStatus(run.conversationId, status === 'error' ? 'error' : 'idle');
      return { message, conversation: conversations.touch(run.conversationId) };
    });
    this.messageUpdated(message);
    this.updated(conversation);
    if (status === 'complete') void this.suggestTitle(run, message);
  }

  /** Forgets a run: timers, maps and the busy flag. */
  private drop(run: LiveRun): void {
    clearTimeout(run.uiTimer);
    clearTimeout(run.dbTimer);
    clearTimeout(run.cancelTimer);
    run.uiTimer = run.dbTimer = run.cancelTimer = undefined;
    this.byRun.delete(run.runId);
    this.live.delete(run.conversationId);
    this.busy.delete(run.conversationId);
  }

  /**
   * After the first reply: a generated title replaces the placeholder, unless
   * the user renamed the conversation in the meantime.
   */
  private async suggestTitle(run: LiveRun, reply: Message): Promise<void> {
    const all = this.deps.messages.all(run.conversationId);
    const replies = all.filter((m) => m.role === 'assistant' && m.status === 'complete');
    const user = all.find((m) => m.role === 'user');
    if (!user || replies.length !== 1 || replies[0]!.id !== reply.id) return;
    const placeholder = placeholderTitle(user.content);
    if (this.deps.conversations.get(run.conversationId)?.title !== placeholder) return;
    const title = await this.deps.title.generate({
      conversationId: run.conversationId,
      agent: run.agent,
      connection: run.connection,
      user,
      reply,
    });
    if (!title || this.closed) return;
    const current = this.deps.conversations.get(run.conversationId);
    if (!current || current.title !== placeholder) return;
    this.updated(this.deps.conversations.rename(run.conversationId, title));
  }

  private nextRev(conversationId: string): number {
    const rev = (this.revs.get(conversationId) ?? 0) + 1;
    this.revs.set(conversationId, rev);
    return rev;
  }

  private messageUpdated(message: Message): void {
    this.emit('message.updated', { message, rev: this.nextRev(message.conversationId) });
  }

  private updated(conversation: Conversation): Conversation {
    this.emit('conversation.updated', { conversation, pendingApproval: null });
    return conversation;
  }

  /** For tests: the live state of a conversation's run. */
  liveRunId(conversationId: string): string | undefined {
    return this.live.get(conversationId)?.runId;
  }
}

/**
 * The history a run gets: finished messages only (errored and streaming
 * replies are left out; cancelled ones keep what the user saw). Tool blocks
 * a CLI harness reported (`harness:*`) are display-only: the harness keeps
 * its own history, and an API provider would reject them. Messages left
 * empty are dropped.
 */
export function buildHistory(messages: readonly Message[]): Message[] {
  const harnessTools = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.status === 'error' || m.status === 'streaming') continue;
    const content = m.content.filter((b) => {
      if (b.type === 'tool_use' && b.toolServerId.startsWith('harness:')) {
        harnessTools.add(b.id);
        return false;
      }
      if (b.type === 'tool_result' && harnessTools.has(b.toolUseId)) return false;
      if (b.type === 'text' && b.text === '') return false;
      return true;
    });
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}
