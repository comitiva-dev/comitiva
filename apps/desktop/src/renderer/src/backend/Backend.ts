import type { ErrorCode, RunnerStatus, SpikeEvent, TestResult } from '@comitiva/contract';

/**
 * The only thing the UI knows about. LocalBackend implements it over IPC
 * today; RemoteBackend (Phase 8) will implement it over HTTP + WebSocket.
 * Phase 0 exposes only what the spike needs.
 */
export interface Backend {
  app: {
    getVersion(): Promise<string>;
  };
  runner: {
    getStatus(): Promise<RunnerStatus>;
  };
  spike: {
    getState(): Promise<{ hasApiKey: boolean; defaultModel: string; weakSecretStorage: boolean }>;
    saveApiKey(apiKey: string): Promise<void>;
    testApiKey(): Promise<TestResult>;
    send(conversationId: string, text: string, model: string): Promise<void>;
    cancel(conversationId: string): Promise<void>;
    reset(conversationId: string): Promise<void>;
    reportLatency(conversationId: string, samplesMs: number[]): Promise<void>;
  };
  onEvent(handler: (event: BackendEvent) => void): () => void;
}

export type BackendEvent =
  { type: 'spike'; event: SpikeEvent } | { type: 'runner.status'; status: RunnerStatus };

/** Error thrown by Backend calls; the UI shows it by `code`, never by message. */
export class BackendError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/** Errors from a Backend call carry a stable code when one is known. */
export function errorCode(err: unknown): ErrorCode {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? (code as ErrorCode) : 'internal';
}
