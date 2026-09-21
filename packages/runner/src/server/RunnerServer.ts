import { AppError, RunnerRequest } from '@comitiva/contract';
import { createDefaultRegistry, type ProviderRegistry } from '../providers/ProviderRegistry.js';
import { McpClientManager } from '../mcp/McpClientManager.js';
import type { OpenConnection } from '../mcp/McpConnection.js';
import { ToolBridge } from '../mcp/ToolBridge.js';
import { RunManager } from '../runs/RunManager.js';
import { createLogger, type Logger } from '../util/logger.js';
import { RequestRouter } from './RequestRouter.js';
import { JsonLinesTransport } from './Transport.js';

export interface RunnerServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  logger?: Logger;
  registry?: ProviderRegistry;
  /** How MCP connections are opened (tests inject in-memory servers). */
  openMcp?: OpenConnection;
  /**
   * Path of `mcp-proxy.cjs`, which CLI harnesses launch to reach the run's
   * tools (ADR 0009). Without it, harness turns get no tools.
   */
  proxyPath?: string;
  /** Called after `shutdown` or when input closes, once runs are cancelled. */
  onExit?: () => void;
}

export class RunnerServer {
  private readonly transport: JsonLinesTransport;
  private readonly logger: Logger;
  private readonly runs: RunManager;
  private readonly mcp: McpClientManager;
  private readonly bridge: ToolBridge | undefined;
  private readonly router: RequestRouter;
  private stopping: Promise<void> | null = null;

  constructor(private readonly opts: RunnerServerOptions) {
    this.logger = opts.logger ?? createLogger();
    this.transport = new JsonLinesTransport(opts.input, opts.output);
    const registry = opts.registry ?? createDefaultRegistry();
    this.mcp = new McpClientManager(this.logger, opts.openMcp ? { open: opts.openMcp } : {});
    this.bridge = opts.proxyPath
      ? new ToolBridge({ proxyPath: opts.proxyPath, logger: this.logger })
      : undefined;
    this.runs = new RunManager({
      registry,
      emit: (e) => this.transport.send(e),
      logger: this.logger,
      mcp: this.mcp,
      bridge: this.bridge,
    });
    this.router = new RequestRouter({
      registry,
      runs: this.runs,
      mcp: this.mcp,
      // Respond first, then stop on the next tick.
      shutdown: () => setImmediate(() => void this.stop()),
    });
  }

  start(): void {
    this.transport.onMessage((msg) => void this.dispatch(msg));
    this.transport.onMalformed((line) => {
      this.logger.warn({ length: line.length }, 'malformed request line');
      this.transport.send({
        type: 'log',
        level: 'warn',
        message: 'Ignored a line that is not valid JSON',
      });
    });
    this.transport.onClose(() => void this.stop());
  }

  /** Cancels runs, closes MCP clients and calls onExit. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.runs
      .cancelAll()
      .then(() => Promise.all([this.mcp.stopAll(), this.bridge?.close()]))
      .then(() => this.opts.onExit?.());
    return this.stopping;
  }

  private async dispatch(msg: unknown): Promise<void> {
    const parsed = RunnerRequest.safeParse(msg);
    if (!parsed.success) {
      const id = typeof msg === 'object' && msg !== null && 'id' in msg ? String(msg.id) : '';
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid';
      this.transport.send({
        type: 'response',
        id,
        ok: false,
        error: new AppError('invalid_request', `Invalid request (${where})`).toJSON(),
      });
      return;
    }
    const req = parsed.data;
    this.logger.debug({ id: req.id, type: req.type }, 'request');
    try {
      const result = await this.router.handle(req);
      this.transport.send({ type: 'response', id: req.id, ok: true, result });
    } catch (err) {
      const e = AppError.from(err);
      this.transport.send({ type: 'response', id: req.id, ok: false, error: e.toJSON() });
    }
  }
}
