import { randomUUID } from 'node:crypto';
import {
  AppError,
  type ApprovalDecision,
  type RunEvent,
  type RunStartRequest,
} from '@comitiva/contract';
import { errorResult } from '../mcp/content.js';
import type { McpClientManager, ServerHandle } from '../mcp/McpClientManager.js';
import { ToolCatalog } from '../mcp/ToolCatalog.js';
import type {
  AdapterEvent,
  CliMcpConfig,
  ProviderAdapter,
  RunContext,
  RunInput,
  ToolResult,
} from '../providers/ProviderAdapter.js';
import { preciseNow } from '../util/jsonl.js';
import type { Logger } from '../util/logger.js';
import { normalizeHistory } from './history.js';
import { isReadOnly, PermissionGate } from './PermissionGate.js';

export type EmitRunEvent = (event: RunEvent) => void;

/** Gives a CLI harness a way back to this run's tools (ToolBridge, ADR 0009). */
export interface CliToolAccess {
  register(run: Run): Promise<CliMcpConfig>;
}

export interface RunDeps {
  adapter: ProviderAdapter;
  emit: EmitRunEvent;
  logger: Logger;
  mcp: McpClientManager;
  bridge?: CliToolAccess | undefined;
}

/**
 * One turn of one conversation. Owns its AbortController; guarantees exactly
 * one terminal event (`run.done` or `run.error`) and nothing after it.
 *
 * Tools: the agent's servers are acquired from the McpClientManager before
 * the adapter starts, and released when the run ends. Every call goes through
 * `callTool`: PermissionGate → (`run.tool_call`, and for `ask` a wait for
 * `run.approval`) → MCP → `run.tool_result`. CLI harnesses reach the same
 * `callTool` through the ToolBridge (docs/tools.md).
 */
export class Run {
  readonly runId: string;
  private readonly controller = new AbortController();
  private finished = false;
  private readonly gate: PermissionGate;
  private catalog = ToolCatalog.empty();
  private handles: ServerHandle[] = [];
  private readonly approvals = new Map<string, (d: ApprovalDecision) => void>();

  constructor(
    private readonly req: RunStartRequest,
    private readonly deps: RunDeps,
  ) {
    this.runId = req.runId;
    this.gate = new PermissionGate(req.agent.permissionPolicy, req.alwaysAllowed ?? []);
  }

  cancel(): void {
    this.controller.abort();
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get conversationId(): string {
    return this.req.conversationId;
  }

  /** The run's tools as the model (or the harness, through the bridge) sees them. */
  get tools(): ToolCatalog {
    return this.catalog;
  }

  /** Answers a pending approval; false when nothing is waiting for that tool call. */
  resolveApproval(toolUseId: string, decision: ApprovalDecision): boolean {
    const resolve = this.approvals.get(toolUseId);
    if (!resolve) return false;
    this.approvals.delete(toolUseId);
    resolve(decision);
    return true;
  }

  async execute(): Promise<void> {
    const signal = this.controller.signal;
    try {
      const input = this.buildInput();
      await abortable(this.openTools(), signal);
      const ctx = this.context();
      for await (const event of this.deps.adapter.run(input, ctx, signal)) {
        this.emit(event);
        if (this.finished) break;
      }
      if (!this.finished)
        this.emit({ type: 'run.done', stopReason: signal.aborted ? 'cancelled' : 'other' });
    } catch (err) {
      if (this.finished) return;
      if (signal.aborted) {
        this.emit({ type: 'run.done', stopReason: 'cancelled' });
        return;
      }
      const e = AppError.from(err);
      this.deps.logger.warn({ runId: this.runId, code: e.code }, 'run failed');
      this.emit({ type: 'run.error', code: e.code, message: e.message, retryable: e.retryable });
    } finally {
      this.approvals.clear();
      for (const h of this.handles) h.release();
      this.handles = [];
    }
  }

  /**
   * Calls a tool on the model's behalf. Denials and tool failures come back as
   * `isError` results (the model reads them and carries on); only a cancel
   * rejects. A call to an unknown tool gets a result but no `run.tool_call`.
   */
  async callTool(toolUseId: string, name: string, input: unknown): Promise<ToolResult> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const entry = this.catalog.resolve(name);
    if (!entry) {
      return this.toolResult(
        toolUseId,
        errorResult('invalid_request', `There is no tool named ${name}`),
        0,
      );
    }
    const decision = this.gate.check(entry.serverId, entry.tool);
    this.emit({
      type: 'run.tool_call',
      toolUseId,
      toolServerId: entry.serverId,
      toolName: entry.tool.name,
      input,
      requiresApproval: decision === 'ask',
    });
    if (decision === 'deny') {
      const refusal = errorResult(
        'approval_denied',
        `This agent is read-only: ${entry.tool.name} is not allowed`,
      );
      return this.toolResult(toolUseId, refusal, 0);
    }
    if (decision === 'ask') {
      const answer = await this.waitForApproval(toolUseId);
      if (answer === 'deny') {
        return this.toolResult(
          toolUseId,
          errorResult('approval_denied', 'The user denied this action'),
          0,
        );
      }
      if (answer === 'allow-always') this.gate.remember(entry.serverId, entry.tool.name);
    }
    const started = performance.now();
    const result = await entry.handle.call(entry.tool.name, input, signal);
    signal.throwIfAborted();
    return this.toolResult(toolUseId, result, performance.now() - started);
  }

  /**
   * A call from a CLI harness through the ToolBridge. The harness's own
   * report of the call is dropped by its parser, so the run reports it here:
   * the tool_use block, then the usual tool_call / tool_result. The id is the
   * harness's tool-use id when the proxy got one, else a new one.
   */
  callFromHarness(name: string, input: unknown, toolUseId?: string): Promise<ToolResult> {
    const id = toolUseId ?? `mcp_${randomUUID()}`;
    this.emit({
      type: 'run.block',
      block: {
        type: 'tool_use',
        id,
        toolServerId: this.catalog.resolve(name)?.serverId ?? '',
        name,
        input: input ?? {},
      },
    });
    return this.callTool(id, name, input);
  }

  private toolResult(toolUseId: string, result: ToolResult, durationMs: number): ToolResult {
    this.emit({
      type: 'run.tool_result',
      toolUseId,
      output: result.content,
      isError: result.isError,
      durationMs: Math.round(durationMs),
    });
    return result;
  }

  private waitForApproval(toolUseId: string): Promise<ApprovalDecision> {
    const signal = this.controller.signal;
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = () => {
        this.approvals.delete(toolUseId);
        reject(signal.reason);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvals.set(toolUseId, (d) => {
        signal.removeEventListener('abort', onAbort);
        resolve(d);
      });
    });
  }

  /** Starts (or reuses) the agent's servers; one that cannot start fails the run. */
  private async openTools(): Promise<void> {
    const launches = this.req.toolServers ?? [];
    if (launches.length === 0) return;
    const settled = await Promise.allSettled(
      launches.map((l) => this.deps.mcp.acquire(l, this.req.agent.roots)),
    );
    const acquired = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    // Cancelled while starting: the run is over and will not release them.
    if (this.controller.signal.aborted) {
      for (const h of acquired) h.release();
      return;
    }
    this.handles.push(...acquired);
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed) throw AppError.from(failed.reason);
    // Under the read-only policy the model does not even see tools that write.
    const filter = this.req.agent.permissionPolicy === 'read-only' ? isReadOnly : undefined;
    this.catalog = new ToolCatalog(this.handles, filter);
  }

  private context(): RunContext {
    const ctx: RunContext = {
      tools: this.catalog.defs(),
      toolServerId: (name) => this.catalog.resolve(name)?.serverId ?? '',
      callTool: (id, name, input) => this.callTool(id, name, input),
      log: (level, msg) => this.deps.logger[level]({ runId: this.runId }, msg),
    };
    const bridge = this.deps.bridge;
    if (bridge && this.deps.adapter.kind === 'cli') {
      ctx.mcpConfigForCli = async () => (this.catalog.size > 0 ? bridge.register(this) : undefined);
    }
    return ctx;
  }

  private buildInput(): RunInput {
    const { agent, connection } = this.req;
    // CLI harnesses fall back to their own default model ('' → no --model flag).
    const model = agent.model ?? connection.config.defaultModel ?? '';
    if (!model && connection.kind === 'api')
      throw new AppError('invalid_request', 'No model set on the agent or the connection');
    return {
      connection,
      secret: this.req.secret,
      model,
      system: agent.role,
      params: agent.params,
      // API providers need strict tool_use → tool_result pairs; harnesses get a transcript.
      messages: connection.kind === 'api' ? normalizeHistory(this.req.messages) : this.req.messages,
      harnessSessionId: this.req.harnessSessionId,
      // CLI harnesses work in the agent's first read-write root, else where the shell says.
      workingDirectory:
        agent.roots.find((r) => r.mode === 'readwrite')?.path ?? this.req.workingDirectory,
    };
  }

  /** Stamps runId and ts; drops anything after the terminal event. */
  emit(event: AdapterEvent): void {
    if (this.finished) return;
    if (event.type === 'run.done' || event.type === 'run.error') this.finished = true;
    this.deps.emit({ ...event, runId: this.runId, ts: preciseNow() } as RunEvent);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
