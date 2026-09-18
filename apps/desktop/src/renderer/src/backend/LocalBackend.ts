import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
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

  spike = {
    getState: () => this.api.invoke('spike.getState', undefined),
    saveApiKey: (apiKey: string) => this.api.invoke('spike.saveApiKey', { apiKey }),
    testApiKey: () => this.api.invoke('spike.testApiKey', undefined),
    send: (conversationId: string, text: string, model: string) =>
      this.api.invoke('spike.send', { conversationId, text, model }),
    cancel: (conversationId: string) => this.api.invoke('spike.cancel', { conversationId }),
    reset: (conversationId: string) => this.api.invoke('spike.reset', { conversationId }),
    reportLatency: (conversationId: string, samplesMs: number[]) =>
      this.api.invoke('spike.reportLatency', { conversationId, samplesMs }),
  };

  onEvent(handler: (event: BackendEvent) => void): () => void {
    const offs = [
      this.api.on('spike.event', (event) => handler({ type: 'spike', event })),
      this.api.on('runner.status', ({ status }) => handler({ type: 'runner.status', status })),
    ];
    return () => offs.forEach((off) => off());
  }
}
