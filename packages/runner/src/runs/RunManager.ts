import { AppError, type ApprovalDecision, type RunStartRequest } from '@comitiva/contract';
import type { McpClientManager } from '../mcp/McpClientManager.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Logger } from '../util/logger.js';
import { Run, type CliToolAccess, type EmitRunEvent } from './Run.js';

/** One Run per runId, all concurrent and independent. */
export class RunManager {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly deps: {
      registry: ProviderRegistry;
      emit: EmitRunEvent;
      logger: Logger;
      mcp: McpClientManager;
      bridge?: CliToolAccess | undefined;
    },
  ) {}

  /** Starts a run without waiting for it; events flow through `emit`. */
  start(req: RunStartRequest): void {
    if (this.runs.has(req.runId)) {
      throw new AppError('invalid_request', `Run ${req.runId} is already active`);
    }
    const adapter = this.deps.registry.get(req.connection.provider);
    const run = new Run(req, { ...this.deps, adapter });
    this.runs.set(req.runId, run);
    void run.execute().finally(() => this.runs.delete(req.runId));
  }

  /** Idempotent: returns false when the run is unknown or already finished. */
  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.cancel();
    return true;
  }

  /** The user's answer to a `run.tool_call` with `requiresApproval`; false when nothing waits. */
  resolveApproval(runId: string, toolUseId: string, decision: ApprovalDecision): boolean {
    return this.runs.get(runId)?.resolveApproval(toolUseId, decision) ?? false;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  active(): string[] {
    return [...this.runs.keys()];
  }

  /** Cancels every run and waits (bounded) for them to emit their terminal event. */
  async cancelAll(timeoutMs = 2000): Promise<void> {
    for (const run of this.runs.values()) run.cancel();
    const deadline = Date.now() + timeoutMs;
    while (this.runs.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
