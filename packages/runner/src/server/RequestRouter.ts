import type { PingResult, RunnerRequest, RunStartResult } from '@comitiva/contract';
import { PROTOCOL_VERSION } from '@comitiva/contract';
import { CliHarnessAdapter } from '../providers/cli/CliHarnessAdapter.js';
import type { McpClientManager } from '../mcp/McpClientManager.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { RunManager } from '../runs/RunManager.js';
import { invalidRequest, notImplemented } from '../util/errors.js';
import { RUNNER_VERSION } from '../version.js';

/** Dispatches validated requests to the component that owns them. */
export class RequestRouter {
  constructor(
    private readonly deps: {
      registry: ProviderRegistry;
      runs: RunManager;
      mcp: McpClientManager;
      shutdown: () => void;
    },
  ) {}

  async handle(req: RunnerRequest): Promise<unknown> {
    switch (req.type) {
      case 'ping':
        return { version: RUNNER_VERSION, protocolVersion: PROTOCOL_VERSION } satisfies PingResult;
      case 'connection.test':
        return this.deps.registry
          .get(req.connection.provider)
          .testConnection(req.connection, req.secret);
      case 'connection.listModels': {
        const adapter = this.deps.registry.get(req.connection.provider);
        if (!adapter.listModels) throw notImplemented(`listModels for ${adapter.id}`);
        return adapter.listModels(req.connection, req.secret);
      }
      case 'cli.detect': {
        const adapter = this.deps.registry.get(req.provider);
        if (!(adapter instanceof CliHarnessAdapter))
          throw invalidRequest(`${req.provider} is not a CLI harness`);
        return adapter.detect(req.binaryPath);
      }
      case 'run.start':
        this.deps.runs.start(req);
        return { runId: req.runId } satisfies RunStartResult;
      case 'run.cancel':
        return { cancelled: this.deps.runs.cancel(req.runId) };
      case 'shutdown':
        this.deps.shutdown();
        return {};
      case 'toolServer.start':
        return this.deps.mcp.start(req.toolServer, req.roots ?? []);
      case 'toolServer.stop':
        await this.deps.mcp.stop(req.toolServerId);
        return {};
      case 'run.approval':
        // An answer for a run that already ended (cancelled, crashed) is a no-op.
        this.deps.runs.resolveApproval(req.runId, req.toolUseId, req.decision);
        return {};
    }
  }
}
