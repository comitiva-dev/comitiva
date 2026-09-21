import type {
  Agent,
  AgentDraft,
  AgentPatch,
  AppSettings,
  AppSettingsPatch,
  CliDetectResult,
  ConnectionDraft,
  ConnectionPatch,
  ConnectionSummary,
  ConnectionTarget,
  DetectBinaryInput,
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
    /** CLI harnesses: finds the binary (typed path or PATH) and reads its version. */
    detectBinary(input: DetectBinaryInput): Promise<CliDetectResult>;
  };
  agents: {
    list(): Promise<Agent[]>;
    /** Rejects with not_found, connection_disabled or model_required when the agent could not run. */
    create(draft: AgentDraft): Promise<Agent>;
    update(id: string, patch: AgentPatch): Promise<Agent>;
    delete(id: string): Promise<void>;
    /** `name` is the copy's (localized) name. */
    duplicate(id: string, name?: string): Promise<Agent>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: AppSettingsPatch): Promise<AppSettings>;
  };
  dialogs: {
    /** A native folder picker; null when cancelled (or when the backend has none). */
    pickFolder(): Promise<string | null>;
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
