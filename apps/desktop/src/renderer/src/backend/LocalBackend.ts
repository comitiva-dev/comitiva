import type {
  ConnectionDraft,
  ConnectionPatch,
  ConnectionTarget,
  DetectBinaryInput,
  IpcInput,
  IpcInvokeChannel,
  IpcOutput,
} from '@comitiva/contract';
import { BackendError, type Backend, type BackendEvent } from './Backend';

/** Backend over the preload bridge. The only module allowed to touch window.api. */
export class LocalBackend implements Backend {
  private readonly api = {
    invoke: async <C extends IpcInvokeChannel>(
      channel: C,
      input: IpcInput<C>,
    ): Promise<IpcOutput<C>> => {
      const result = await window.api.invoke(channel, input);
      if (result.ok) return result.value;
      throw new BackendError(result.error.code, result.error.message, result.error.retryable);
    },
    on: window.api.on,
  };

  app = {
    getVersion: () => this.api.invoke('app.getVersion', undefined),
  };

  runner = {
    getStatus: async () => (await this.api.invoke('runner.getStatus', undefined)).status,
  };

  secrets = {
    getStatus: () => this.api.invoke('secrets.getStatus', undefined),
  };

  connections = {
    list: () => this.api.invoke('connections.list', undefined),
    create: (draft: ConnectionDraft) => this.api.invoke('connections.create', draft),
    update: (id: string, patch: ConnectionPatch) =>
      this.api.invoke('connections.update', { id, patch }),
    delete: (id: string) => this.api.invoke('connections.delete', { id }),
    test: (target: ConnectionTarget) => this.api.invoke('connections.test', target),
    listModels: (target: ConnectionTarget) => this.api.invoke('connections.listModels', target),
    detectBinary: (input: DetectBinaryInput) => this.api.invoke('connections.detectBinary', input),
  };

  dialogs = {
    pickFolder: () => this.api.invoke('dialogs.pickFolder', undefined),
  };

  onEvent(handler: (event: BackendEvent) => void): () => void {
    return this.api.on('runner.status', ({ status }) => handler({ type: 'runner.status', status }));
  }
}
