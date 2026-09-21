import { ulid } from 'ulid';
import {
  AppError,
  providerKind,
  secretRequirement,
  type CliDetectResult,
  type Connection,
  type ConnectionDraft,
  type ConnectionPatch,
  type ConnectionSummary,
  type ConnectionTarget,
  type DetectBinaryInput,
  type ModelInfo,
  type TestResult,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import type {
  ConnectionRecord,
  ConnectionRepository,
} from '../db/repositories/ConnectionRepository';
import type { SecretStore } from '../secrets/SecretStore';

type RunnerPort = Pick<RunnerClient, 'testConnection' | 'listModels' | 'detectCli'>;

export interface ConnectionServiceDeps {
  repo: ConnectionRepository;
  secrets: SecretStore;
  runner: RunnerPort;
}

export const secretRefFor = (connectionId: string): string => `connection:${connectionId}`;

/**
 * Connections as the UI manages them. Keys go to the SecretStore under a
 * `secretRef`; SQLite and every value returned here carry only the ref and
 * `hasSecret`. Keys reach the runner per request and nowhere else. CLI
 * harness connections never have a key: the harness uses its own login.
 */
export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  async list(): Promise<ConnectionSummary[]> {
    return Promise.all(this.deps.repo.list().map((r) => this.summary(r)));
  }

  async create(draft: ConnectionDraft): Promise<ConnectionSummary> {
    const id = ulid();
    const apiKey = 'apiKey' in draft ? draft.apiKey : undefined;
    const secretRef = apiKey ? secretRefFor(id) : null;
    // Validate before touching the secret store, so a bad draft stores nothing.
    this.deps.repo.preview(this.probeConnection(draft, id), {});
    if (apiKey && secretRef) await this.deps.secrets.set(secretRef, apiKey);
    try {
      const record = this.deps.repo.create({
        id,
        name: draft.name,
        provider: draft.provider,
        config: draft.config,
        enabled: draft.enabled,
        secretRef,
      });
      return await this.summary(record);
    } catch (err) {
      if (secretRef) await this.deps.secrets.delete(secretRef).catch(() => {});
      throw err;
    }
  }

  async update(id: string, patch: ConnectionPatch): Promise<ConnectionSummary> {
    const current = this.deps.repo.require(id).connection;
    if (current.kind === 'cli' && typeof patch.apiKey === 'string') {
      throw new AppError('invalid_request', 'CLI connections do not take an API key');
    }
    const ref = current.secretRef ?? secretRefFor(id);
    const secretRef = patch.apiKey === undefined ? undefined : patch.apiKey === null ? null : ref;
    const changes = {
      name: patch.name,
      enabled: patch.enabled,
      config: patch.config,
      secretRef,
      keyChanged: patch.apiKey !== undefined,
    };
    this.deps.repo.preview(current, changes); // throws invalid_request before any secret change
    if (typeof patch.apiKey === 'string') await this.deps.secrets.set(ref, patch.apiKey);
    const record = this.deps.repo.update(id, changes);
    if (patch.apiKey === null && current.secretRef) {
      await this.deps.secrets.delete(current.secretRef);
    }
    return this.summary(record);
  }

  async delete(id: string): Promise<void> {
    const { connection } = this.deps.repo.require(id);
    this.deps.repo.delete(id);
    if (connection.secretRef) await this.deps.secrets.delete(connection.secretRef).catch(() => {});
  }

  /**
   * Tests a saved connection (`{ id }`, result recorded for the list) or
   * unsaved settings (`probe`, optionally reusing the stored key of `id`).
   * Never throws for provider or secret problems: they come back as
   * `{ ok: false, error }` so the UI shows them the same way.
   */
  async test(target: ConnectionTarget): Promise<TestResult> {
    let result: TestResult;
    try {
      const { connection, secret } = await this.resolve(target);
      result = await this.deps.runner.testConnection({
        type: 'connection.test',
        connection,
        ...(secret !== undefined ? { secret } : {}),
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found') throw err;
      result = { ok: false, error: AppError.from(err).toJSON() };
    }
    if (target.id !== undefined && target.probe === undefined) {
      this.deps.repo.recordTest(target.id, result);
    }
    return result;
  }

  async listModels(target: ConnectionTarget): Promise<ModelInfo[]> {
    const { connection, secret } = await this.resolve(target);
    return this.deps.runner.listModels({
      type: 'connection.listModels',
      connection,
      ...(secret !== undefined ? { secret } : {}),
    });
  }

  /**
   * The key a run needs, read per request and never kept. CLI harnesses use
   * their own login. Throws `secret_missing` when the provider requires a key
   * and none is stored.
   */
  async secretFor(connection: Connection): Promise<string | undefined> {
    if (connection.kind === 'cli') return undefined;
    const secret = connection.secretRef
      ? ((await this.deps.secrets.get(connection.secretRef)) ?? undefined)
      : undefined;
    const preset =
      connection.provider === 'openai-compatible' ? connection.config.preset : undefined;
    if (!secret && secretRequirement(connection.provider, preset) === 'required') {
      throw new AppError('secret_missing', `Connection ${connection.name} has no API key`);
    }
    return secret;
  }

  /** Finds a harness binary (the typed path, or PATH) and reads its version. */
  detectBinary(input: DetectBinaryInput): Promise<CliDetectResult> {
    return this.deps.runner.detectCli({
      type: 'cli.detect',
      provider: input.provider,
      ...(input.binaryPath !== undefined ? { binaryPath: input.binaryPath } : {}),
    });
  }

  private async resolve(
    target: ConnectionTarget,
  ): Promise<{ connection: Connection; secret: string | undefined }> {
    const saved = target.id !== undefined ? this.deps.repo.require(target.id).connection : null;
    const connection = target.probe
      ? this.deps.repo.preview(this.probeConnection(target.probe, target.id ?? 'probe'), {})
      : saved!;
    if (connection.kind === 'cli') return { connection, secret: undefined };
    const probeKey = target.probe && 'apiKey' in target.probe ? target.probe.apiKey : undefined;
    const secret =
      probeKey ??
      (saved?.secretRef
        ? ((await this.deps.secrets.get(saved.secretRef)) ?? undefined)
        : undefined);
    return { connection, secret };
  }

  /** A transient Connection for settings that are not saved (yet). */
  private probeConnection(
    probe: Pick<ConnectionDraft, 'provider' | 'config'> & { name?: string },
    id: string,
  ): Connection {
    const now = new Date().toISOString();
    return {
      id,
      name: probe.name ?? 'probe',
      kind: providerKind(probe.provider),
      provider: probe.provider,
      config: probe.config,
      secretRef: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as Connection;
  }

  private async summary(record: ConnectionRecord): Promise<ConnectionSummary> {
    const ref = record.connection.secretRef;
    return {
      connection: record.connection,
      hasSecret: ref ? await this.deps.secrets.has(ref) : false,
      lastTest: record.lastTest,
    };
  }
}
