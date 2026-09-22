import { createHash } from 'node:crypto';
import {
  AppError,
  type AgentRoot,
  type BuiltinToolServer,
  type ToolDef,
  type ToolServerLaunch,
} from '@comitiva/contract';
import type { ToolResult } from '../providers/ProviderAdapter.js';
import type { Logger } from '../util/logger.js';
import { errorResult } from './content.js';
import { openConnection, type McpConnection, type OpenConnection } from './McpConnection.js';

/** A run's hold on one server: its tools, and calls that restart it when it died. */
export interface ServerHandle {
  readonly serverId: string;
  readonly name: string;
  readonly builtin: BuiltinToolServer | undefined;
  readonly tools: ToolDef[];
  /** Never throws for server failures (they become `isError` results); rejects on abort. */
  call(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult>;
  /** Ends the hold; a superseded instance closes when its last holder releases it. */
  release(): void;
}

interface Instance {
  key: string;
  launch: ToolServerLaunch;
  extraArgs: string[];
  conn: McpConnection | undefined;
  starting: Promise<McpConnection> | undefined;
  refs: number;
  /** Replaced by an instance with another launch spec or other roots. */
  superseded: boolean;
  failures: number;
  retryAt: number;
  tools: ToolDef[];
  /** Stopped by the shell: never restarted. */
  closed: boolean;
  idleTimer: NodeJS.Timeout | undefined;
}

const MAX_BACKOFF_MS = 30_000;
/**
 * Built-in instances nobody used for this long are closed: filesystem
 * instances are per set of roots (an agent whose roots changed leaves its old
 * instance behind), and a Google Drive instance holds an access token that
 * expires (the next run brings a fresh one).
 */
export const BUILTIN_IDLE_MS = 10 * 60_000;

/**
 * One MCP client per server launch, started on demand and reused across runs
 * (SPEC §4.3). An instance is keyed by the server id plus a hash of its launch
 * spec and roots: the built-in filesystem server gets the agent's roots as
 * arguments, so agents with different roots get different instances, and an
 * edited server gets a fresh one. A dead instance is restarted on its next use,
 * with backoff (1 s, 2 s, 4 s … 30 s) after failed starts.
 */
export class McpClientManager {
  private readonly instances = new Map<string, Instance>();
  private readonly open: OpenConnection;

  constructor(
    private readonly logger: Logger,
    opts: { open?: OpenConnection } = {},
  ) {
    this.open = opts.open ?? openConnection;
  }

  /** Starts (or reuses) the server and holds it until `release()`. */
  async acquire(launch: ToolServerLaunch, roots: readonly AgentRoot[] = []): Promise<ServerHandle> {
    const extraArgs = builtinArgs(launch, roots);
    const key = `${launch.id}#${hash({ launch, extraArgs })}`;
    let inst = this.instances.get(key);
    if (!inst) {
      inst = {
        key,
        launch,
        extraArgs,
        conn: undefined,
        starting: undefined,
        refs: 0,
        superseded: false,
        failures: 0,
        retryAt: 0,
        tools: [],
        closed: false,
        idleTimer: undefined,
      };
      this.instances.set(key, inst);
      this.supersedeOthers(inst);
    }
    inst.refs++;
    clearTimeout(inst.idleTimer);
    try {
      await this.ensure(inst);
    } catch (err) {
      this.release(inst);
      throw err;
    }
    return this.handle(inst);
  }

  /** `toolServer.start`: starts the server, keeps it warm, returns its tools. */
  async start(launch: ToolServerLaunch, roots: readonly AgentRoot[] = []): Promise<ToolDef[]> {
    const handle = await this.acquire(launch, roots);
    handle.release();
    return handle.tools;
  }

  /** Closes every instance of a server (disabled or deleted by the user). */
  async stop(serverId: string): Promise<void> {
    const closing = [...this.instances.values()]
      .filter((i) => i.launch.id === serverId)
      .map((i) => this.close(i));
    await Promise.all(closing);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((i) => this.close(i)));
  }

  /** For tests and diagnostics. */
  liveInstances(): Array<{ serverId: string; refs: number; alive: boolean }> {
    return [...this.instances.values()].map((i) => ({
      serverId: i.launch.id,
      refs: i.refs,
      alive: i.conn?.alive ?? false,
    }));
  }

  private handle(inst: Instance): ServerHandle {
    let released = false;
    return {
      serverId: inst.launch.id,
      name: inst.launch.name,
      builtin: inst.launch.transport === 'stdio' ? inst.launch.builtin : undefined,
      tools: inst.tools,
      call: (name, input, signal) => this.call(inst, name, input, signal),
      release: () => {
        if (released) return;
        released = true;
        this.release(inst);
      },
    };
  }

  private async call(
    inst: Instance,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    let conn: McpConnection;
    try {
      conn = await this.ensure(inst);
    } catch (err) {
      return errorResult('tool_server_failed', AppError.from(err).message);
    }
    try {
      return await conn.call(name, input, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const message = (err as Error).message;
      // A session that ended mid-call (crash, exit) is restarted on the next call.
      if (!conn.alive)
        return errorResult('tool_server_failed', `${inst.launch.name} stopped: ${message}`);
      return errorResult('tool_failed', message);
    }
  }

  /** The live connection, starting it when needed (shared by concurrent callers). */
  private ensure(inst: Instance): Promise<McpConnection> {
    if (inst.closed) {
      return Promise.reject(
        new AppError('tool_server_failed', `${inst.launch.name} was stopped`, { retryable: false }),
      );
    }
    if (inst.conn?.alive) return Promise.resolve(inst.conn);
    if (inst.starting) return inst.starting;
    const wait = inst.retryAt - Date.now();
    if (wait > 0) {
      return Promise.reject(
        new AppError(
          'tool_server_failed',
          `${inst.launch.name} failed to start; retrying in ${Math.ceil(wait / 1000)} s`,
          { retryable: true },
        ),
      );
    }
    const log = (msg: string) => this.logger.debug({ server: inst.launch.id }, msg);
    inst.starting = this.open(inst.launch, inst.extraArgs, log).then(
      (conn) => {
        inst.starting = undefined;
        if (inst.closed) {
          void conn.close();
          throw new AppError('tool_server_failed', `${inst.launch.name} was stopped`);
        }
        inst.conn = conn;
        inst.tools.splice(0, inst.tools.length, ...conn.tools);
        inst.failures = 0;
        inst.retryAt = 0;
        conn.onClose(() => {
          this.logger.warn({ server: inst.launch.id }, 'tool server exited');
          if (inst.conn === conn) inst.conn = undefined;
        });
        return conn;
      },
      (err: unknown) => {
        inst.starting = undefined;
        inst.failures++;
        inst.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (inst.failures - 1));
        this.logger.warn(
          { server: inst.launch.id, failures: inst.failures },
          'tool server failed to start',
        );
        if (err instanceof AppError && err.code === 'tool_server_failed') throw err;
        throw new AppError(
          'tool_server_failed',
          `${inst.launch.name} did not start: ${(err as Error).message}`,
          { retryable: true, cause: err },
        );
      },
    );
    return inst.starting;
  }

  private release(inst: Instance): void {
    inst.refs = Math.max(0, inst.refs - 1);
    if (inst.refs > 0) return;
    if (inst.superseded) void this.close(inst);
    else if (inst.launch.transport === 'stdio' && inst.launch.builtin) {
      inst.idleTimer = setTimeout(() => void this.close(inst), BUILTIN_IDLE_MS);
      inst.idleTimer.unref();
    }
  }

  private supersedeOthers(current: Instance): void {
    for (const other of this.instances.values()) {
      if (other === current || other.launch.id !== current.launch.id) continue;
      // The filesystem server runs one instance per set of roots: only an
      // edited launch spec replaces those.
      if (isFilesystem(other.launch) && hash(other.launch) === hash(current.launch)) continue;
      other.superseded = true;
      if (other.refs === 0) void this.close(other);
    }
  }

  private async close(inst: Instance): Promise<void> {
    inst.closed = true;
    clearTimeout(inst.idleTimer);
    this.instances.delete(inst.key);
    const conn = inst.conn ?? (await inst.starting?.catch(() => undefined));
    inst.conn = undefined;
    await conn?.close();
  }
}

const isFilesystem = (launch: ToolServerLaunch): boolean =>
  launch.transport === 'stdio' && launch.builtin === 'filesystem';

/**
 * Built-in servers get the approval flag (the runner asks before every write
 * call); the filesystem server also gets the agent's roots.
 */
function builtinArgs(launch: ToolServerLaunch, roots: readonly AgentRoot[]): string[] {
  if (launch.transport !== 'stdio' || !launch.builtin) return [];
  if (launch.builtin === 'google-drive') return ['--gated-by-client'];
  return [...roots.flatMap((r) => ['--root', `${r.path}:${r.mode}`]), '--gated-by-client'];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
