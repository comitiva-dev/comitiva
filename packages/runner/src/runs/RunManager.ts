import { AppError, type RunStartRequest } from '@comitiva/contract';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Logger } from '../util/logger.js';
import { Run, type EmitRunEvent } from './Run.js';

/** One Run per runId, all concurrent and independent. */
export class RunManager {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly emit: EmitRunEvent,
    private readonly logger: Logger,
  ) {}

  /** Starts a run without waiting for it; events flow through `emit`. */
  start(req: RunStartRequest): void {
    if (this.runs.has(req.runId)) {
      throw new AppError('invalid_request', `Run ${req.runId} is already active`);
    }
    const adapter = this.registry.get(req.connection.provider);
    const run = new Run(req, adapter, this.emit, this.logger);
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
