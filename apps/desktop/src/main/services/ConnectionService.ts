import { ulid } from 'ulid';
import {
  AppError,
  type Connection,
  type ConnectionDraft,
  type ConnectionPatch,
  type ConnectionSummary,
  type ConnectionTarget,
  type ModelInfo,
  type TestResult,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import type {
  ConnectionRecord,
  ConnectionRepository,
} from '../db/repositories/ConnectionRepository';
import type { SecretStore } from '../secrets/SecretStore';

type RunnerPort = Pick<RunnerClient, 'testConnection' | 'listModels'>;

export interface ConnectionServiceDeps {
  repo: ConnectionRepository;
  secrets: SecretStore;
  runner: RunnerPort;
}

export const secretRefFor = (connectionId: string): string => `connection:${connectionId}`;

/**
 * Connections as the UI manages them. Keys go to the SecretStore under a
 * `secretRef`; SQLite and every value returned here carry only the ref and
 * `hasSecret`. Keys reach the runner per request and nowhere else.
 */
export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  async list(): Promise<ConnectionSummary[]> {
    return Promise.all(this.deps.repo.list().map((r) => this.summary(r)));
  }

  async create(draft: ConnectionDraft): Promise<ConnectionSummary> {
    const id = ulid();
    const secretRef = draft.apiKey ? secretRefFor(id) : null;
    // Validate before touching the secret store, so a bad draft stores nothing.
    this.deps.repo.preview(this.probeConnection(draft, id), {});
    if (draft.apiKey && secretRef) await this.deps.secrets.set(secretRef, draft.apiKey);
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

  private async resolve(
    target: ConnectionTarget,
  ): Promise<{ connection: Connection; secret: string | undefined }> {
    const saved = target.id !== undefined ? this.deps.repo.require(target.id).connection : null;
    const connection = target.probe
      ? this.deps.repo.preview(this.probeConnection(target.probe, target.id ?? 'probe'), {})
      : saved!;
    const secret =
      target.probe?.apiKey ??
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
      kind: 'api',
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
