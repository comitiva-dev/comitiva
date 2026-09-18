import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AppError,
  ModelInfo,
  RunnerEvent,
  TestResult,
  isRunEvent,
  type ApprovalDecision,
  type DistributiveOmit,
  type LogEvent,
  type PingResult,
  type RunEvent,
  type RunnerRequest,
  type RunStartRequest,
} from '@comitiva/contract';
import { LineSplitter, encodeLine } from '../util/jsonl.js';

export type RunnerRequestPayload = DistributiveOmit<RunnerRequest, 'id'>;
export type RunStartPayload = Omit<RunStartRequest, 'id' | 'type' | 'runId'> & { runId?: string };

export interface RunnerClientOptions {
  /** Spawns the runner process with piped stdin/stdout. */
  spawn: () => ChildProcess;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: AppError) => void;
  timer: NodeJS.Timeout;
}

interface RunnerClientEvents {
  'run.event': [event: RunEvent & { receivedAt: number }];
  log: [event: LogEvent];
  crash: [code: number | null, signal: NodeJS.Signals | null];
  exit: [];
}

/**
 * What shells embed to talk to the runner: spawns it, correlates requests and
 * responses by id, and re-emits run events. When the process dies, pending
 * requests are rejected and every active run gets a synthetic
 * `run.error { code: 'runner_crashed', retryable: true }`.
 *
 * One client instance manages one process lifetime; supervisors restart by
 * calling `start()` again after `crash`.
 */
export class RunnerClient extends EventEmitter<RunnerClientEvents> {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly activeRuns = new Set<string>();
  private nextId = 1;
  private stopping = false;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: RunnerClientOptions) {
    super();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Spawns the process and waits for a successful ping. */
  async start(): Promise<PingResult> {
    if (this.child) throw new AppError('invalid_request', 'Runner already started');
    this.stopping = false;
    const child = this.opts.spawn();
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new AppError(
        'runner_unavailable',
        'Runner must be spawned with piped stdin and stdout',
      );
    }
    this.child = child;
    const splitter = new LineSplitter((line) => this.handleLine(line));
    child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk));
    child.stdin.on('error', () => {}); // EPIPE when the child dies; handled by 'exit'.
    child.once('exit', (code, signal) => this.handleExit(child, code, signal));
    child.once('error', () => this.handleExit(child, null, null));
    return this.request<PingResult>({ type: 'ping' });
  }

  request<T>(payload: RunnerRequestPayload): Promise<T> {
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(
        new AppError('runner_unavailable', 'Runner is not running', { retryable: true }),
      );
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError('timeout', `Runner did not answer ${payload.type}`, { retryable: true }),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin!.write(encodeLine({ ...payload, id }));
    });
  }

  /**
   * Starts a run and returns its id immediately. Failures to start are
   * reported as a `run.error` event for that run, so callers handle every
   * outcome in one place.
   */
  startRun(payload: RunStartPayload): { runId: string } {
    const runId = payload.runId ?? randomUUID();
    this.activeRuns.add(runId);
    this.request({ ...payload, type: 'run.start', runId }).catch((err: unknown) => {
      if (!this.activeRuns.delete(runId)) return;
      const e = AppError.from(err);
      this.emit('run.event', {
        type: 'run.error',
        runId,
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        receivedAt: Date.now(),
      });
    });
    return { runId };
  }

  cancelRun(runId: string): void {
    if (!this.activeRuns.has(runId)) return;
    this.request({ type: 'run.cancel', runId }).catch(() => {});
  }

  approve(runId: string, toolUseId: string, decision: ApprovalDecision): void {
    this.request({ type: 'run.approval', runId, toolUseId, decision }).catch(() => {});
  }

  /** Never rejects for provider failures: they come back as `{ ok: false, error }`. */
  async testConnection(
    payload: Extract<RunnerRequestPayload, { type: 'connection.test' }>,
  ): Promise<TestResult> {
    return parseResult(TestResult, await this.request(payload), payload.type);
  }

  /** Rejects with the provider error (auth_failed, provider_unavailable, …). */
  async listModels(
    payload: Extract<RunnerRequestPayload, { type: 'connection.listModels' }>,
  ): Promise<ModelInfo[]> {
    return parseResult(ModelInfo.array(), await this.request(payload), payload.type);
  }

  activeRunIds(): string[] {
    return [...this.activeRuns];
  }

  /** Asks the runner to shut down, then kills it if it does not exit in time. */
  async stop(timeoutMs = 3000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.request({ type: 'shutdown' }).catch(() => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  private handleLine(line: string): void {
    const receivedAt = performance.timeOrigin + performance.now();
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.emit('log', {
        type: 'log',
        level: 'warn',
        message: 'Runner wrote a non-JSON line to stdout',
      });
      return;
    }
    const parsed = RunnerEvent.safeParse(json);
    if (!parsed.success) {
      this.emit('log', {
        type: 'log',
        level: 'warn',
        message: 'Runner sent an event that does not match the contract',
      });
      return;
    }
    const event = parsed.data;
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      if (event.ok) pending.resolve(event.result);
      else pending.reject(AppError.fromShape(event.error));
      return;
    }
    if (event.type === 'log') {
      this.emit('log', event);
      return;
    }
    if (isRunEvent(event)) {
      if (event.type === 'run.done' || event.type === 'run.error') {
        if (!this.activeRuns.delete(event.runId)) return; // already finalized (e.g. crash)
      }
      this.emit('run.event', { ...event, receivedAt });
    }
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.child = null;
    const crashed = new AppError('runner_crashed', 'Runner process exited', { retryable: true });
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(crashed);
      this.pending.delete(id);
    }
    for (const runId of this.activeRuns) {
      this.emit('run.event', {
        type: 'run.error',
        runId,
        code: 'runner_crashed',
        message: crashed.message,
        retryable: true,
        receivedAt: Date.now(),
      });
    }
    this.activeRuns.clear();
    if (this.stopping) this.emit('exit');
    else this.emit('crash', code, signal);
  }
}

function parseResult<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('internal', `Runner sent an invalid ${what} result`);
  return parsed.data;
}
