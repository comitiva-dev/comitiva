import type { PingResult, RunnerRequest, RunStartResult } from '@comitiva/contract';
import { PROTOCOL_VERSION } from '@comitiva/contract';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { RunManager } from '../runs/RunManager.js';
import { notImplemented } from '../util/errors.js';
import { RUNNER_VERSION } from '../version.js';

/** Dispatches validated requests to the component that owns them. */
export class RequestRouter {
  constructor(
    private readonly deps: { registry: ProviderRegistry; runs: RunManager; shutdown: () => void },
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
      case 'run.start':
        this.deps.runs.start(req);
        return { runId: req.runId } satisfies RunStartResult;
      case 'run.cancel':
        return { cancelled: this.deps.runs.cancel(req.runId) };
      case 'shutdown':
        this.deps.shutdown();
        return {};
      case 'toolServer.start':
      case 'toolServer.stop':
      case 'run.approval':
        throw notImplemented(req.type);
    }
  }
}
