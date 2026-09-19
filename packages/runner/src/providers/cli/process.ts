import { spawn, type ChildProcess } from 'node:child_process';
import { AppError } from '@comitiva/contract';
import { LineSplitter } from '../../util/jsonl.js';

/**
 * One harness process: prompt on stdin, JSON lines on stdout, stderr kept for
 * error messages. POSIX children run in their own process group so a kill
 * also reaches the shells and tools the harness started.
 */

export interface HarnessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface HarnessProcess {
  /** stdout lines as they arrive; throws `timeout` when the idle timeout fired. */
  lines: AsyncIterable<string>;
  exited: Promise<HarnessExit>;
  /** The last few KB of stderr (can contain content: log it at debug only). */
  stderrTail(): string;
  /** SIGTERM to the process group, SIGKILL after a grace period. Idempotent. */
  kill(): void;
  readonly pid: number | undefined;
}

export interface SpawnHarnessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  signal?: AbortSignal;
  /** Ends the process with `timeout` after this long without stdout. */
  idleTimeoutMs?: number;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

const STDERR_TAIL_BYTES = 8 * 1024;

export function spawnHarness(
  bin: string,
  args: string[],
  opts: SpawnHarnessOptions,
): HarnessProcess {
  const windows = process.platform === 'win32';
  const shim = windows && /\.(cmd|bat)$/i.test(bin);
  const child: ChildProcess = shim
    ? // Node refuses to spawn .cmd/.bat without a shell; quote every argument for cmd.exe.
      spawn(quoteWin(bin), args.map(quoteWin), {
        cwd: opts.cwd,
        env: opts.env,
        shell: true,
        windowsHide: true,
      })
    : spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: !windows,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });

  // ------------------------------------------------------------ lifecycle
  let exitInfo: HarnessExit | undefined;
  let spawnError: Error | undefined;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const exited = new Promise<HarnessExit>((resolve) => {
    child.once('error', (err) => {
      spawnError = err;
      exitInfo ??= { code: null, signal: null };
      resolve(exitInfo);
      wake();
    });
    child.once('close', (code, signal) => {
      exitInfo = { code, signal };
      if (killTimer) clearTimeout(killTimer);
      resolve(exitInfo);
      wake();
    });
  });

  const signalGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined || exitInfo) return;
    try {
      if (windows)
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  let killed = false;
  const kill = () => {
    if (killed || exitInfo) return;
    killed = true;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), opts.killGraceMs ?? 3000);
    killTimer.unref();
  };

  const onAbort = () => kill();
  if (opts.signal?.aborted) queueMicrotask(kill);
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  void exited.then(() => opts.signal?.removeEventListener('abort', onAbort));

  // ---------------------------------------------------------------- stdin
  child.stdin?.on('error', () => {}); // EPIPE when the harness exits before reading
  child.stdin?.end(opts.stdin ?? '');

  // --------------------------------------------------------------- stdout
  const queue: string[] = [];
  let ended = false;
  let waiter: (() => void) | undefined;
  function wake() {
    const w = waiter;
    waiter = undefined;
    w?.();
  }
  const splitter = new LineSplitter((line) => {
    queue.push(line);
    wake();
  });

  let idle: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (!opts.idleTimeoutMs) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.idleTimeoutMs);
    idle.unref();
  };
  armIdle();
  child.stdout?.on('data', (chunk: Buffer) => {
    armIdle();
    splitter.push(chunk);
  });
  child.stdout?.once('end', () => {
    splitter.end();
    ended = true;
    if (idle) clearTimeout(idle);
    wake();
  });
  void exited.then(() => {
    if (idle) clearTimeout(idle);
  });

  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      const line = queue.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (spawnError) throw spawnFailure(bin, spawnError);
      if (ended || (exitInfo && !child.stdout)) break;
      await new Promise<void>((r) => (waiter = r));
    }
    if (timedOut) {
      throw new AppError('timeout', `No output from ${bin} for ${opts.idleTimeoutMs} ms`, {
        retryable: true,
      });
    }
  }

  return {
    lines: lines(),
    exited,
    stderrTail: () => stderr,
    kill,
    get pid() {
      return child.pid;
    },
  };
}

/**
 * Runs a short command to completion (version, auth status, sandbox probe)
 * and collects its output. Never throws for a non-zero exit.
 */
export async function runCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const proc = spawnHarness(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    signal,
    killGraceMs: 500,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  const out: string[] = [];
  for await (const line of proc.lines) out.push(line);
  const exit = await proc.exited;
  return {
    code: exit.code,
    stdout: out.join('\n'),
    stderr: proc.stderrTail(),
    timedOut: signal.aborted,
  };
}

function spawnFailure(bin: string, err: Error): AppError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return new AppError('binary_not_found', `Cannot run ${bin}: ${err.message}`, { cause: err });
  }
  return new AppError('internal', `Cannot start ${bin}: ${err.message}`, { cause: err });
}

function quoteWin(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) || arg === '' ? `"${arg.replace(/"/g, '""')}"` : arg;
}
