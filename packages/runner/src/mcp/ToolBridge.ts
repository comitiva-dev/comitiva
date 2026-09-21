import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, type ToolDef } from '@comitiva/contract';
import type { CliMcpConfig, ToolResult } from '../providers/ProviderAdapter.js';
import type { CliToolAccess, Run } from '../runs/Run.js';
import { LineSplitter, encodeLine } from '../util/jsonl.js';
import type { Logger } from '../util/logger.js';
import { BRIDGE_SERVER_NAME } from './names.js';

/** What the proxy reads from the file named on its command line. */
export interface BridgeFile {
  socket: string;
  token: string;
}

/** Proxy → bridge, JSON lines over the socket. */
export type BridgeRequest =
  | { id: number; type: 'hello'; token: string }
  | { id: number; type: 'list' }
  | { id: number; type: 'call'; name: string; input: unknown; toolUseId?: string | undefined };

/** Bridge → proxy. */
export type BridgeResponse =
  | { id: number; ok: true; tools?: ToolDef[]; result?: ToolResult }
  | { id: number; ok: false; error: string };

/**
 * How CLI harnesses reach a run's tools (ADR 0009). The runner listens on a
 * local socket (a Unix socket in a 0700 temp dir; a named pipe on Windows).
 * For each turn it writes an MCP config whose only server is the proxy
 * (`mcp-proxy.cjs`), plus a 0600 file with the socket and a per-run token.
 * The harness launches the proxy; the proxy connects back, proves the token,
 * and forwards `tools/list` and `tools/call` to the run. Calls go through
 * `Run.callTool`, the same gate and approvals as API runs, and the runner
 * stays the only MCP client of the real servers.
 */
export class ToolBridge implements CliToolAccess {
  private server: Server | undefined;
  private listening: Promise<{ socket: string; dir: string }> | undefined;
  private readonly sessions = new Map<string, Run>();
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly opts: {
      /** Absolute path of `mcp-proxy.cjs`. */
      proxyPath: string;
      logger: Logger;
      /** Node binary for the proxy (default: the runner's own, Electron in Node mode included). */
      nodePath?: string;
    },
  ) {}

  async register(run: Run): Promise<CliMcpConfig> {
    const { socket, dir } = await this.listen();
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, run);
    const stem = join(dir, `${run.runId.replace(/[^A-Za-z0-9_-]/g, '_')}-${token.slice(0, 8)}`);
    const bridgeFile = `${stem}.bridge.json`;
    const configFile = `${stem}.mcp.json`;
    const command = this.opts.nodePath ?? process.execPath;
    const args = [this.opts.proxyPath, bridgeFile];
    // The runner itself may be Electron in Node mode; the proxy must be too.
    const env: Record<string, string> =
      process.env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    await writePrivate(bridgeFile, JSON.stringify({ socket, token } satisfies BridgeFile));
    await writePrivate(
      configFile,
      JSON.stringify({
        mcpServers: { [BRIDGE_SERVER_NAME]: { type: 'stdio', command, args, env } },
      }),
    );
    return {
      path: configFile,
      command,
      args,
      env,
      serverName: BRIDGE_SERVER_NAME,
      hasFilesystem: run.tools.hasBuiltin('filesystem'),
      cleanup: async () => {
        this.sessions.delete(token);
        await Promise.all([rm(bridgeFile, { force: true }), rm(configFile, { force: true })]);
      },
    };
  }

  async close(): Promise<void> {
    this.sessions.clear();
    for (const s of this.sockets) s.destroy();
    const listening = this.listening;
    this.listening = undefined;
    if (!listening) return;
    const { dir } = await listening.catch(() => ({ dir: undefined }));
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  private listen(): Promise<{ socket: string; dir: string }> {
    this.listening ??= (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'comitiva-bridge-'));
      await chmod(dir, 0o700);
      const socket =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\comitiva-${process.pid}-${randomBytes(8).toString('hex')}`
          : join(dir, 'bridge.sock');
      const server = createServer((s) => this.accept(s));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, () => resolve());
      });
      return { socket, dir };
    })();
    return this.listening;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let run: Run | undefined;
    const reply = (r: BridgeResponse) => {
      if (!socket.destroyed) socket.write(encodeLine(r));
    };
    const splitter = new LineSplitter((line) => {
      let req: BridgeRequest;
      try {
        req = JSON.parse(line) as BridgeRequest;
      } catch {
        socket.destroy();
        return;
      }
      if (req.type === 'hello') {
        run = this.sessions.get(req.token);
        if (!run) {
          reply({ id: req.id, ok: false, error: 'unknown token' });
          socket.end();
          return;
        }
        reply({ id: req.id, ok: true });
        return;
      }
      // Nothing before a valid hello.
      if (!run) {
        socket.destroy();
        return;
      }
      if (req.type === 'list') {
        reply({ id: req.id, ok: true, tools: run.tools.defs() });
        return;
      }
      if (req.type === 'call') {
        run.callFromHarness(req.name, req.input, req.toolUseId).then(
          (result) => reply({ id: req.id, ok: true, result }),
          (err: unknown) => reply({ id: req.id, ok: false, error: AppError.from(err).message }),
        );
      }
    });
    socket.on('data', (chunk: Buffer) => splitter.push(chunk));
    socket.on('error', (err) =>
      this.opts.logger.debug({ err: err.message }, 'bridge socket error'),
    );
    socket.on('close', () => this.sockets.delete(socket));
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
}
