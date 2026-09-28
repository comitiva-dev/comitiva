import { ulid } from 'ulid';
import {
  AppError,
  appendText,
  type AppErrorShape,
  type ApprovalDecision,
  type Block,
  type Connection,
  type Message,
  type MessageStatus,
  type PendingApproval,
  type RunEvent,
  type RunUsageEvent,
  type StopReason,
  type UserContent,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import type { TitleService } from '../TitleService';
import { resolveWorkingDirectory } from '../workingDirectory';
import type { ChatStore, RunSession, RunTarget } from './ChatStore';

export type RunnerPort = Pick<RunnerClient, 'startRun' | 'cancelRun' | 'approve' | 'on' | 'off'>;

export interface RunEngineDeps {
  store: ChatStore;
  runner: RunnerPort;
  /** The run's key, read per request (ConnectionService.secretFor); throws secret_missing. */
  secretFor(connection: Connection): Promise<string | undefined>;
  title: Pick<TitleService, 'generate'>;
  /** `<userData>/workspaces`: default working directory of CLI harness conversations. */
  workspacesDir: string;
  cancelGraceMs?: number;
  log?: (message: string) => void;
}

/** One active run: the streaming reply lives here until it is final. */
export interface LiveRun {
  runId: string;
  conversationId: string;
  messageId: string;
  target: RunTarget;
  model: string;
  /** Authoritative content of the streaming reply. */
  blocks: Block[];
  usage: RunUsageEvent | undefined;
  startedAt: number;
  cancelTimer: NodeJS.Timeout | undefined;
  /** A tool call waiting for the user (tools run one at a time: at most one). */
  pending: PendingApproval | undefined;
  session: RunSession;
}

/**
 * Runs turns: one per conversation at a time, every conversation on its own
 * (no global queue). It resolves what a run needs before anything is
 * persisted, starts the runner, turns its events into the reply's blocks and
 * hands them to the store's session, and ends every run exactly once.
 *
 * The same engine runs Personal conversations (LocalChatStore) and workspace
 * conversations on a hub (HubChatStore): execution always stays on this
 * desktop.
 */
export class RunEngine {
  /** Conversations with a run starting or streaming: the double-send guard. */
  private readonly busy = new Set<string>();
  private readonly live = new Map<string, LiveRun>();
  private readonly byRun = new Map<string, LiveRun>();
  private closed = false;
  private readonly cancelGraceMs: number;

  constructor(private readonly deps: RunEngineDeps) {
    this.cancelGraceMs = deps.cancelGraceMs ?? 10_000;
    deps.runner.on('run.event', this.onRunEvent);
  }

  /** The live run of a conversation, if one is streaming. */
  liveRun(conversationId: string): LiveRun | undefined {
    return this.live.get(conversationId);
  }

  pendingOf(conversationId: string): PendingApproval | null {
    return this.live.get(conversationId)?.pending ?? null;
  }

  /**
   * Persists the user message and an empty reply, then starts the run.
   * Refusals (busy, connection disabled, no model, no key) throw before
   * anything is written; run failures end the reply in `error`.
   */
  async send(conversationId: string, content: UserContent): Promise<void> {
    await this.begin(conversationId, content);
  }

  /** Runs the last reply again when it ended in `error`, in the same message. */
  async retry(conversationId: string): Promise<void> {
    await this.begin(conversationId, null);
  }

  /**
   * Asks the runner to cancel; the run ends with its usage and
   * `done(cancelled)`, which leaves the reply `cancelled` (partial content
   * kept). If the runner never answers, the reply is finalized locally after
   * a grace period. Returns false when nothing runs here.
   */
  cancel(conversationId: string): boolean {
    const run = this.live.get(conversationId);
    if (!run) return false;
    if (run.cancelTimer) return true;
    this.deps.runner.cancelRun(run.runId);
    run.cancelTimer = setTimeout(
      () => this.finish(run, 'cancelled', null, null, Date.now()),
      this.cancelGraceMs,
    );
    return true;
  }

  /**
   * The user's answer to the pending tool call: recorded (allow-always makes
   * later calls of that tool by this agent run without asking), sent to the
   * runner, and the conversation goes back to `running`.
   */
  decide(conversationId: string, toolUseId: string, decision: ApprovalDecision): void {
    const run = this.live.get(conversationId);
    const pending = run?.pending;
    if (!run || !pending || pending.toolUseId !== toolUseId) {
      throw new AppError('invalid_request', 'Nothing is waiting for that decision');
    }
    run.pending = undefined;
    let recorded: void | Promise<void>;
    try {
      recorded = run.session.decided(pending, decision);
    } catch (err) {
      run.pending = pending;
      throw err;
    }
    this.deps.runner.approve(run.runId, toolUseId, decision);
    void Promise.resolve(recorded).catch((err: unknown) =>
      this.log(`recording a decision failed: ${AppError.from(err).message}`),
    );
  }

  /** Before an agent (and its conversations) goes away: stop its runs, write nothing. */
  forgetAgent(agentId: string): void {
    for (const run of [...this.live.values()]) {
      if (run.target.agent.id !== agentId) continue;
      this.deps.runner.cancelRun(run.runId);
      this.drop(run);
      run.session.close();
    }
  }

  /** Before quitting: every active run is cancelled and finalized as `cancelled` now. */
  shutdown(): void {
    this.closed = true;
    for (const run of [...this.live.values()]) {
      this.deps.runner.cancelRun(run.runId);
      this.finish(run, 'cancelled', null, 'cancelled', Date.now());
    }
    this.deps.runner.off('run.event', this.onRunEvent);
  }

  /** For tests: the live state of a conversation's run. */
  liveRunId(conversationId: string): string | undefined {
    return this.live.get(conversationId)?.runId;
  }

  // ------------------------------------------------------------------- runs

  private async begin(conversationId: string, content: UserContent | null): Promise<void> {
    this.reserve(conversationId);
    try {
      if (content === null) this.deps.store.checkRetry?.(conversationId);
      const target = await this.deps.store.target(conversationId);
      const ctx = await this.prepare(target);
      const runId = ulid();
      const turn = await this.deps.store.beginTurn({ conversationId, runId, content, target });
      await this.start(conversationId, runId, target, ctx, turn.reply, turn.history, turn.session);
    } catch (err) {
      this.busy.delete(conversationId);
      throw err;
    }
  }

  private reserve(conversationId: string): void {
    if (this.closed) throw new AppError('runner_unavailable', 'The app is closing');
    if (this.busy.has(conversationId)) {
      throw new AppError('conversation_busy', 'This conversation is already running');
    }
    this.busy.add(conversationId);
  }

  private async prepare(target: RunTarget) {
    const { agent, connection } = target;
    if (!connection.enabled) {
      throw new AppError('connection_disabled', `Connection ${connection.name} is disabled`);
    }
    const model = agent.model ?? connection.config.defaultModel ?? '';
    if (!model && connection.kind === 'api') {
      throw new AppError('model_required', `Agent ${agent.name} has no model`);
    }
    const secret = await this.deps.secretFor(connection);
    const toolServers = await target.launches();
    const alwaysAllowed = this.deps.store.alwaysAllowed(agent.id);
    return { model, secret, toolServers, alwaysAllowed };
  }

  private async start(
    conversationId: string,
    runId: string,
    target: RunTarget,
    ctx: Awaited<ReturnType<RunEngine['prepare']>>,
    reply: Message,
    history: Message[],
    session: RunSession,
  ): Promise<void> {
    const { agent, connection } = target;
    const run: LiveRun = {
      runId,
      conversationId,
      messageId: reply.id,
      target,
      model: ctx.model,
      blocks: [],
      usage: undefined,
      startedAt: Date.now(),
      cancelTimer: undefined,
      pending: undefined,
      session,
    };
    // Registered before the request goes out: a failed start comes back as run.error.
    this.live.set(conversationId, run);
    this.byRun.set(runId, run);
    let messages: Message[];
    try {
      messages = await this.deps.store.resolveHistory(buildHistory(history));
    } catch (err) {
      // The turn is stored: it ends as an error the user can retry.
      this.finish(run, 'error', AppError.from(err).toJSON(), null, Date.now());
      return;
    }
    if (this.byRun.get(runId) !== run) return; // dropped meanwhile (agent deleted, app closing)
    const harnessSessionId = this.deps.store.harnessSession(conversationId, connection.id);
    const workingDirectory = resolveWorkingDirectory(
      connection,
      conversationId,
      this.deps.workspacesDir,
    );
    this.deps.runner.startRun({
      runId,
      conversationId,
      agent,
      connection,
      messages,
      toolServers: ctx.toolServers,
      alwaysAllowed: ctx.alwaysAllowed,
      ...(ctx.secret !== undefined ? { secret: ctx.secret } : {}),
      ...(harnessSessionId !== undefined ? { harnessSessionId } : {}),
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    });
  }

  private readonly onRunEvent = (e: RunEvent & { receivedAt: number }): void => {
    const run = this.byRun.get(e.runId);
    if (!run) return; // title runs, runs of another engine, or a run already finalized
    try {
      this.handle(run, e);
    } catch (err) {
      // A listener must not throw into the runner client's stdout handler.
      this.log(`failed to handle ${e.type}: ${AppError.from(err).message}`);
    }
  };

  private handle(run: LiveRun, e: RunEvent & { receivedAt: number }): void {
    switch (e.type) {
      case 'run.session':
        // Persisted at once, so a crash mid-turn still resumes the harness session.
        this.deps.store.setHarnessSession(
          run.conversationId,
          e.harnessSessionId,
          run.target.connection.id,
        );
        return;
      case 'run.text_delta':
        run.blocks = appendText(run.blocks, e.text);
        run.session.text(e.text, run.blocks);
        return;
      case 'run.block':
        run.blocks = [...run.blocks, e.block];
        run.session.block(e.block, run.blocks);
        return;
      case 'run.usage':
        run.usage = e; // recorded with the terminal event: one record per run
        return;
      case 'run.tool_call':
        run.session.toolCall(e);
        if (!e.requiresApproval) return;
        run.pending = {
          toolUseId: e.toolUseId,
          toolServerId: e.toolServerId,
          toolName: e.toolName,
          input: e.input,
        };
        run.session.awaitingApproval(run.pending);
        return;
      case 'run.tool_result': {
        if (run.pending?.toolUseId === e.toolUseId) run.pending = undefined;
        const block: Block = {
          type: 'tool_result',
          toolUseId: e.toolUseId,
          content: e.output,
          isError: e.isError,
          durationMs: e.durationMs,
        };
        run.blocks = [...run.blocks, block];
        run.session.block(block, run.blocks);
        return;
      }
      case 'run.done':
        this.finish(
          run,
          e.stopReason === 'cancelled' ? 'cancelled' : 'complete',
          null,
          e.stopReason,
          e.receivedAt,
        );
        return;
      case 'run.error':
        this.finish(
          run,
          'error',
          { code: e.code, message: e.message, retryable: e.retryable },
          null,
          e.receivedAt,
        );
        return;
    }
  }

  private finish(
    run: LiveRun,
    status: Extract<MessageStatus, 'complete' | 'cancelled' | 'error'>,
    error: AppErrorShape | null,
    stopReason: StopReason | null,
    at: number,
  ): void {
    if (this.byRun.get(run.runId) !== run) return;
    this.drop(run);
    const u = run.usage;
    const finished = run.session.finish({
      status,
      blocks: run.blocks,
      error,
      stopReason,
      usage: u
        ? {
            // What the provider or harness actually ran beats what we asked
            // for: a CLI connection often names no model at all.
            model: u.model ?? run.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens ?? null,
            cacheWriteTokens: u.cacheWriteTokens ?? null,
            estimated: u.estimated,
            reportedCostUsd: u.reportedCostUsd ?? null,
            latencyMs: Math.max(0, Math.round(at - run.startedAt)),
          }
        : null,
    });
    const titled = (message: Message | null) =>
      status === 'complete' && message ? this.suggestTitle(run, message) : undefined;
    const failed = (err: unknown) =>
      this.log(`finishing a run failed: ${AppError.from(err).message}`);
    if (finished instanceof Promise) {
      void finished.then(titled).catch(failed);
    } else {
      void titled(finished)?.catch(failed);
    }
  }

  /** Forgets a run: its cancel timer, the maps and the busy flag. */
  private drop(run: LiveRun): void {
    clearTimeout(run.cancelTimer);
    run.cancelTimer = undefined;
    this.byRun.delete(run.runId);
    this.live.delete(run.conversationId);
    this.busy.delete(run.conversationId);
  }

  /**
   * After the first reply: a generated title replaces the placeholder, unless
   * the conversation was renamed in the meantime.
   */
  private async suggestTitle(run: LiveRun, reply: Message): Promise<void> {
    const candidate = run.session.titleCandidate(reply);
    if (!candidate) return;
    const title = await this.deps.title.generate({
      conversationId: run.conversationId,
      agent: run.target.agent,
      connection: run.target.connection,
      user: candidate.user,
      reply,
    });
    if (!title || this.closed) return;
    await run.session.applyTitle(title, candidate.placeholder);
  }

  private log(message: string): void {
    (this.deps.log ?? ((m: string) => console.error(`RunEngine: ${m}`)))(message);
  }
}

/**
 * The history a run gets: finished messages only (errored and streaming
 * replies are left out; cancelled ones keep what the user saw). Tool blocks
 * a CLI harness reported for its native tools (`harness:*`) are display-only:
 * the harness keeps its own history, and an API provider would reject them.
 * Calls to MCP tools stay (the runner pairs them into provider turns).
 * Messages left empty are dropped.
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
