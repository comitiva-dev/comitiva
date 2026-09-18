import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RunnerStatus } from '@comitiva/contract';
import { RunnerClient } from '@comitiva/runner';
import { RotatingLog } from './RotatingLog';

export interface RunnerSupervisorOptions {
  /** Path to the bundled runner (`bin.cjs`). */
  runnerEntry: string;
  /** Where the runner's stderr goes. */
  logFile: string;
  /** Executable; defaults to the Electron binary itself in Node mode (ADR 0002). */
  command?: string;
  env?: NodeJS.ProcessEnv;
  backoff?: { initialMs: number; maxMs: number; stableAfterMs: number };
}

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 30_000, stableAfterMs: 30_000 };

/**
 * Owns the runner process: spawns it as `process.execPath` with
 * ELECTRON_RUN_AS_NODE=1, pipes its stderr to a rotating log, and restarts it
 * with exponential backoff (1s, 2s, 4s… 30s) when it dies. Active runs get
 * `run.error(runner_crashed)` from the RunnerClient.
 */
export class RunnerSupervisor extends EventEmitter<{ status: [RunnerStatus] }> {
  readonly client: RunnerClient;
  private readonly log: RunnerLog;
  private readonly backoff: typeof DEFAULT_BACKOFF;
  private attempt = 0;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private _status: RunnerStatus = 'stopped';

  constructor(private readonly opts: RunnerSupervisorOptions) {
    super();
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.log = new RunnerLog(opts.logFile);
    this.client = new RunnerClient({ spawn: () => this.spawnRunner() });
    this.client.on('crash', (code, signal) => this.onCrash(code, signal));
    this.client.on('log', (e) => this.log.line(`[${e.level}] ${e.message}`));
  }

  get status(): RunnerStatus {
    return this._status;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus(this.attempt === 0 ? 'starting' : 'restarting');
    try {
      await this.client.start();
      this.startedAt = Date.now();
      this.setStatus('ready');
    } catch (err) {
      this.log.line(`runner failed to start: ${String(err)}`);
      // A failed ping means the process is up but broken: kill it and let the crash path retry.
      if (this.client.running) await this.client.stop(500);
      this.scheduleRestart();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.client.stop();
    this.setStatus('stopped');
  }

  private spawnRunner(): ChildProcess {
    const child = spawn(this.opts.command ?? process.execPath, [this.opts.runnerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(this.opts.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk: Buffer) => this.log.raw(chunk));
    return child;
  }

  private onCrash(code: number | null, signal: NodeJS.Signals | null): void {
    this.log.line(`runner exited (code=${code}, signal=${signal})`);
    if (this.stopped) return;
    if (Date.now() - this.startedAt > this.backoff.stableAfterMs) this.attempt = 0;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(this.backoff.initialMs * 2 ** this.attempt, this.backoff.maxMs);
    this.attempt++;
    this.setStatus('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
  }

  private setStatus(status: RunnerStatus): void {
    if (status === this._status) return;
    this._status = status;
    this.emit('status', status);
  }
}

class RunnerLog {
  private readonly file: RotatingLog;
  constructor(path: string) {
    this.file = new RotatingLog(path);
  }
  raw(chunk: Buffer): void {
    this.file.write(chunk);
  }
  line(text: string): void {
    this.file.write(`${new Date().toISOString()} ${text}\n`);
  }
}
