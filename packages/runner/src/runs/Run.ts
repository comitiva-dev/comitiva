import { AppError, type RunEvent, type RunStartRequest } from '@comitiva/contract';
import { preciseNow } from '../util/jsonl.js';
import type { Logger } from '../util/logger.js';
import type {
  AdapterEvent,
  ProviderAdapter,
  RunContext,
  RunInput,
} from '../providers/ProviderAdapter.js';

export type EmitRunEvent = (event: RunEvent) => void;

/**
 * One turn of one conversation. Owns its AbortController; guarantees exactly
 * one terminal event (`run.done` or `run.error`) and nothing after it.
 */
export class Run {
  readonly runId: string;
  private readonly controller = new AbortController();
  private finished = false;

  constructor(
    private readonly req: RunStartRequest,
    private readonly adapter: ProviderAdapter,
    private readonly emitEvent: EmitRunEvent,
    private readonly logger: Logger,
  ) {
    this.runId = req.runId;
  }

  cancel(): void {
    this.controller.abort();
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  async execute(): Promise<void> {
    const signal = this.controller.signal;
    const ctx: RunContext = {
      tools: [],
      callTool: () => Promise.reject(new AppError('not_implemented', 'Tools arrive in Phase 5')),
      log: (level, msg) => this.logger[level]({ runId: this.runId }, msg),
    };

    try {
      const input = this.buildInput();
      for await (const event of this.adapter.run(input, ctx, signal)) {
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
      this.logger.warn({ runId: this.runId, code: e.code }, 'run failed');
      this.emit({ type: 'run.error', code: e.code, message: e.message, retryable: e.retryable });
    }
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
      messages: this.req.messages,
      harnessSessionId: this.req.harnessSessionId,
      workingDirectory: this.req.workingDirectory,
    };
  }

  private emit(event: AdapterEvent): void {
    if (this.finished) return;
    if (event.type === 'run.done' || event.type === 'run.error') this.finished = true;
    this.emitEvent({ ...event, runId: this.runId, ts: preciseNow() } as RunEvent);
  }
}
