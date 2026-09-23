import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppError,
  cliProviderDescriptors,
  type CliConfig,
  type CliDetectResult,
  type CliProviderId,
  type Connection,
  type StopReason,
  type TestResult,
} from '@comitiva/contract';
import type {
  AdapterEvent,
  CliMcpConfig,
  ProviderAdapter,
  RunContext,
  RunInput,
} from '../ProviderAdapter.js';
import { streamTurn, UsageTracker } from '../api/shared.js';
import { locateBinary } from './locateBinary.js';
import type { HarnessParser, ParserOptions } from './parsers/types.js';
import { stderrSummary } from './parsers/types.js';
import { runCommand, spawnHarness } from './process.js';
import { buildPrompt, harnessEnv } from './prompt.js';

/** What a subclass needs to build one invocation. */
export interface TurnSpec {
  config: CliConfig & Record<string, unknown>;
  /** Empty → the harness's default model. */
  model: string;
  system: string;
  /** Session to resume, when the harness keeps the history. */
  resume: string | undefined;
  /** The run's tools through the runner's proxy (ADR 0009); undefined without tools. */
  mcp: CliMcpConfig | undefined;
  /** A connection test: no session persistence, no tools. */
  probe: boolean;
}

export interface CliHarnessOptions {
  /** Base env for the harness (default: the runner's). Stripped by `harnessEnv`. */
  env?: NodeJS.ProcessEnv;
  /** Extra install dirs to search (tests). Default: `defaultInstallDirs()`. */
  searchDirs?: string[];
  /** A turn ends with `timeout` after this long without output. Default 10 min. */
  idleTimeoutMs?: number;
  /** Deadline for the test prompt. Default 90 s (CLI cold starts are slow). */
  probeTimeoutMs?: number;
}

const VERSION_TIMEOUT_MS = 10_000;

/**
 * Base for CLI harness adapters (Claude Code, Codex): one child process per
 * turn, prompt on stdin, JSON lines on stdout. Rules: docs/providers.md →
 * CLI harnesses.
 */
export abstract class CliHarnessAdapter implements ProviderAdapter {
  abstract readonly id: CliProviderId;
  readonly kind = 'cli' as const;

  constructor(protected readonly options: CliHarnessOptions = {}) {}

  get capabilities() {
    return cliProviderDescriptors[this.id].capabilities;
  }

  protected get label(): string {
    return cliProviderDescriptors[this.id].label;
  }

  protected abstract buildArgs(turn: TurnSpec): string[];
  protected abstract createParser(opts: ParserOptions): HarnessParser;
  /** Throws `not_logged_in` when the harness has no login. */
  protected abstract authCheck(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void>;
  /** Extra checks before the test prompt (Codex: the sandbox). */
  protected preflight(
    _bin: string,
    _env: NodeJS.ProcessEnv,
    _cwd: string,
    _connection: Connection,
  ): Promise<void> {
    return Promise.resolve();
  }

  protected env(): NodeJS.ProcessEnv {
    return harnessEnv(this.options.env ?? process.env);
  }

  /** Extra env for a turn (Claude Code: how long an MCP call may take). */
  protected turnEnv(_turn: TurnSpec): Record<string, string> {
    return {};
  }

  protected locate(binaryPath: string | undefined): Promise<string> {
    const d = cliProviderDescriptors[this.id];
    return locateBinary({
      name: d.binaryName,
      label: d.label,
      explicit: binaryPath,
      env: this.options.env ?? process.env,
      ...(this.options.searchDirs ? { extraDirs: this.options.searchDirs } : {}),
    });
  }

  /** Finds the binary and reads its version: the form's "Detect". */
  async detect(binaryPath?: string): Promise<CliDetectResult> {
    const path = await this.locate(binaryPath);
    const env = this.env();
    const r = await runCommand(path, ['--version'], {
      cwd: tmpdir(),
      env,
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const version = r.stdout.trim().split('\n')[0] ?? '';
    if (r.code !== 0 || version === '') {
      throw new AppError(
        'binary_not_found',
        `${path} did not answer --version like ${this.label}${r.timedOut ? ' (timed out)' : ''}: ${stderrSummary(r.stderr) || `exit ${r.code}`}`,
      );
    }
    return { path, version };
  }

  async testConnection(connection: Connection): Promise<TestResult> {
    const started = performance.now();
    let dir: string | undefined;
    try {
      const config = connection.config as CliConfig;
      const { path: bin } = await this.detect(config.binaryPath);
      dir = await mkdtemp(join(tmpdir(), 'comitiva-probe-'));
      const env = this.env();
      await this.authCheck(bin, env, dir);
      await this.preflight(bin, env, dir, connection);
      await this.probePrompt(bin, connection, dir);
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: AppError.from(err).toJSON() };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A minimal real turn: proves the harness can reach its model with this login. */
  private async probePrompt(bin: string, connection: Connection, cwd: string): Promise<void> {
    const signal = AbortSignal.timeout(this.options.probeTimeoutMs ?? 90_000);
    const usage = new UsageTracker(0);
    const parser = this.createParser({ usage, log: () => {}, idPrefix: 'probe_' });
    const config = connection.config as TurnSpec['config'];
    const proc = spawnHarness(
      bin,
      this.buildArgs({
        config,
        model: config.defaultModel ?? '',
        system: '',
        resume: undefined,
        mcp: undefined,
        probe: true,
      }),
      { cwd, env: this.env(), stdin: 'Reply with the single word OK.', signal },
    );
    try {
      for await (const line of proc.lines) parser.push(parseJson(line));
      const exit = await proc.exited;
      if (signal.aborted) {
        throw new AppError('timeout', `${this.label} did not answer the test prompt in time`, {
          retryable: true,
        });
      }
      parser.finish(exit, proc.stderrTail());
    } finally {
      proc.kill();
    }
  }

  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    const body = () => this.turn(input, ctx, signal, usage);
    return streamTurn({ signal, usage, toAppError: (e) => AppError.from(e), body });
  }

  private async *turn(
    input: RunInput,
    ctx: RunContext,
    signal: AbortSignal,
    usage: UsageTracker,
  ): AsyncGenerator<AdapterEvent, StopReason> {
    const config = input.connection.config as TurnSpec['config'];
    const cwd = input.workingDirectory ?? config.workingDirectory;
    if (!cwd) {
      throw new AppError('invalid_request', 'A CLI turn needs a working directory');
    }
    const bin = await this.locate(config.binaryPath);
    await mkdir(cwd, { recursive: true });
    const mcp = await ctx.mcpConfigForCli?.();
    const idPrefix = `${Date.now().toString(36)}_`;

    try {
      let resume = input.harnessSessionId;
      for (let attempt = 0; ; attempt++) {
        const parser = this.createParser({ usage, log: ctx.log, idPrefix });
        const spec: TurnSpec = {
          config,
          model: input.model,
          system: input.system,
          resume,
          mcp,
          probe: false,
        };
        const proc = spawnHarness(bin, this.buildArgs(spec), {
          cwd,
          env: { ...this.env(), ...this.turnEnv(spec) },
          stdin: buildPrompt(input.messages, resume !== undefined, this.label),
          signal,
          idleTimeoutMs: this.options.idleTimeoutMs ?? 10 * 60_000,
        });
        let yielded = false;
        try {
          for await (const line of proc.lines) {
            for (const event of parser.push(parseJson(line, ctx))) {
              if (event.type !== 'run.session') yielded = true;
              yield event;
            }
          }
          const exit = await proc.exited;
          const stderr = proc.stderrTail();
          if (stderr) ctx.log('debug', `${this.id} stderr: ${stderr}`);
          if (resume && attempt === 0 && !yielded && parser.sessionNotFound(stderr)) {
            // The harness lost the session: replay the history into a new one.
            ctx.log('info', `${this.id}: session ${resume} not found, replaying history`);
            resume = undefined;
            continue;
          }
          return parser.finish(exit, stderr);
        } finally {
          proc.kill();
        }
      }
    } finally {
      await mcp?.cleanup().catch(() => {});
    }
  }
}

function parseJson(line: string, ctx?: Pick<RunContext, 'log'>): unknown {
  try {
    return JSON.parse(line);
  } catch {
    ctx?.log('debug', `ignored non-JSON harness line (${line.length} chars)`);
    return undefined;
  }
}
