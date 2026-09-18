import type {
  ConnectionDraft,
  ConnectionPatch,
  ConnectionSummary,
  ConnectionTarget,
  ErrorCode,
  ModelInfo,
  RunnerStatus,
  SecretStorageStatus,
  TestResult,
} from '@comitiva/contract';

/**
 * The only thing the UI knows about. LocalBackend implements it over IPC
 * today; RemoteBackend (Phase 8) will implement it over HTTP + WebSocket.
 * It grows phase by phase (docs/design.md §7).
 */
export interface Backend {
  app: {
    getVersion(): Promise<string>;
  };
  runner: {
    getStatus(): Promise<RunnerStatus>;
  };
  secrets: {
    getStatus(): Promise<SecretStorageStatus>;
  };
  connections: {
    list(): Promise<ConnectionSummary[]>;
    create(draft: ConnectionDraft): Promise<ConnectionSummary>;
    update(id: string, patch: ConnectionPatch): Promise<ConnectionSummary>;
    delete(id: string): Promise<void>;
    /** Resolves with `{ ok: false, error }` for provider failures; rejects only for bad input. */
    test(target: ConnectionTarget): Promise<TestResult>;
    listModels(target: ConnectionTarget): Promise<ModelInfo[]>;
  };
  onEvent(handler: (event: BackendEvent) => void): () => void;
}

export type BackendEvent = { type: 'runner.status'; status: RunnerStatus };

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
