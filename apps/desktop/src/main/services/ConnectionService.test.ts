import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, type ConnectionDraft } from '@comitiva/contract';
import { Database } from '../db/Database';
import { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import type { SecretStore } from '../secrets/SecretStore';
import { ConnectionService } from './ConnectionService';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  available = true;
  async set(ref: string, value: string) {
    if (!this.available) throw new AppError('secret_store_unavailable', 'no keyring');
    this.values.set(ref, value);
  }
  async get(ref: string) {
    if (!this.available) throw new AppError('secret_store_unavailable', 'no keyring');
    return this.values.get(ref) ?? null;
  }
  async has(ref: string) {
    return this.values.has(ref);
  }
  async delete(ref: string) {
    this.values.delete(ref);
  }
  status() {
    return { available: this.available, weak: false };
  }
}

let db: Database;
let repo: ConnectionRepository;
let secrets: MemorySecrets;
let runner: {
  testConnection: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
};
let service: ConnectionService;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'db', 'migrations'));
  repo = new ConnectionRepository(db);
  secrets = new MemorySecrets();
  runner = {
    testConnection: vi.fn(async () => ({ ok: true as const, latencyMs: 42 })),
    listModels: vi.fn(async () => [{ id: 'm1' }]),
  };
  service = new ConnectionService({ repo, secrets, runner: runner as never });
});
afterEach(() => db.close());

const anthropic: ConnectionDraft = {
  name: 'Anthropic',
  provider: 'anthropic',
  config: { defaultModel: 'claude-haiku-4-5' },
  apiKey: 'sk-ant-secret',
};

describe('ConnectionService', () => {
  it('stores the key in the SecretStore and only a ref in SQLite', async () => {
    const created = await service.create(anthropic);
    expect(created.hasSecret).toBe(true);
    expect(created.connection.secretRef).toBe(`connection:${created.connection.id}`);
    expect(JSON.stringify(created)).not.toContain('sk-ant-secret');
    expect(secrets.values.get(created.connection.secretRef!)).toBe('sk-ant-secret');

    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM connections').all());
    expect(dump).not.toContain('sk-ant-secret');
  });

  it('creates keyless connections without touching the store', async () => {
    const created = await service.create({
      name: 'Local',
      provider: 'ollama',
      config: { baseUrl: 'http://localhost:11434' },
    });
    expect(created).toMatchObject({ hasSecret: false, connection: { secretRef: null } });
    expect(secrets.values.size).toBe(0);
  });

  it('fails with secret_store_unavailable before writing anything', async () => {
    secrets.available = false;
    await expect(service.create(anthropic)).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });
    expect(repo.list()).toEqual([]);
  });

  it('does not store the key when the draft is invalid', async () => {
    await expect(
      service.create({
        name: 'x',
        provider: 'openai-compatible',
        config: { baseUrl: 'bad' },
        apiKey: 'k',
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(secrets.values.size).toBe(0);
  });

  it('keeps, replaces and removes the key on update', async () => {
    const { connection } = await service.create(anthropic);
    const ref = connection.secretRef!;

    const renamed = await service.update(connection.id, { name: 'Renamed' });
    expect(renamed).toMatchObject({
      hasSecret: true,
      connection: { name: 'Renamed', secretRef: ref },
    });
    expect(secrets.values.get(ref)).toBe('sk-ant-secret');

    await service.update(connection.id, { apiKey: 'sk-ant-new' });
    expect(secrets.values.get(ref)).toBe('sk-ant-new');

    const removed = await service.update(connection.id, { apiKey: null });
    expect(removed).toMatchObject({ hasSecret: false, connection: { secretRef: null } });
    expect(secrets.values.has(ref)).toBe(false);

    const added = await service.update(connection.id, { apiKey: 'sk-again' });
    expect(added.hasSecret).toBe(true);
    expect(secrets.values.get(added.connection.secretRef!)).toBe('sk-again');
  });

  it('validates config changes against the provider', async () => {
    const { connection } = await service.create({
      name: 'Groq',
      provider: 'openai-compatible',
      config: { baseUrl: 'https://api.groq.com/openai/v1', preset: 'groq' },
      apiKey: 'gsk',
    });
    await expect(
      service.update(connection.id, { config: { baseUrl: 'nope' }, apiKey: 'other' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // The key did not change either.
    expect(secrets.values.get(connection.secretRef!)).toBe('gsk');
  });

  it('deletes the row and its key; refuses while agents use it', async () => {
    const { connection } = await service.create(anthropic);
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO agents (id, name, avatar, connection_id, created_at, updated_at) VALUES ('a', 'A', 'x', ?, ?, ?)`,
      )
      .run(connection.id, now, now);
    await expect(service.delete(connection.id)).rejects.toMatchObject({
      code: 'connection_in_use',
    });
    expect(secrets.values.size).toBe(1);

    db.raw.prepare('DELETE FROM agents').run();
    await service.delete(connection.id);
    expect(await service.list()).toEqual([]);
    expect(secrets.values.size).toBe(0);
    await expect(service.delete(connection.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('tests a saved connection with its stored key and records the result', async () => {
    const { connection } = await service.create(anthropic);
    expect(await service.test({ id: connection.id })).toEqual({ ok: true, latencyMs: 42 });
    expect(runner.testConnection).toHaveBeenCalledWith({
      type: 'connection.test',
      connection: expect.objectContaining({ id: connection.id, provider: 'anthropic' }),
      secret: 'sk-ant-secret',
    });
    const [summary] = await service.list();
    expect(summary!.lastTest).toMatchObject({ ok: true, latencyMs: 42, errorCode: null });

    runner.testConnection.mockResolvedValueOnce({
      ok: false,
      error: { code: 'auth_failed', message: 'bad', retryable: false },
    });
    expect(await service.test({ id: connection.id })).toMatchObject({ ok: false });
    expect((await service.list())[0]!.lastTest).toMatchObject({
      ok: false,
      errorCode: 'auth_failed',
    });
  });

  it('tests unsaved settings without recording, reusing the stored key when none is typed', async () => {
    const { connection } = await service.create(anthropic);
    const probe = { provider: 'anthropic' as const, config: { baseUrl: 'https://proxy.example' } };

    await service.test({ id: connection.id, probe });
    expect(runner.testConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        secret: 'sk-ant-secret',
        connection: expect.objectContaining({ config: { baseUrl: 'https://proxy.example' } }),
      }),
    );
    await service.test({ probe: { ...probe, apiKey: 'typed' } });
    expect(runner.testConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ secret: 'typed' }),
    );
    expect((await service.list())[0]!.lastTest).toBeNull();
  });

  it('reports runner and secret failures as a failed test, not a thrown error', async () => {
    const { connection } = await service.create(anthropic);
    runner.testConnection.mockRejectedValueOnce(
      new AppError('runner_unavailable', 'down', { retryable: true }),
    );
    expect(await service.test({ id: connection.id })).toMatchObject({
      ok: false,
      error: { code: 'runner_unavailable', retryable: true },
    });
    secrets.available = false;
    expect(await service.test({ id: connection.id })).toMatchObject({
      ok: false,
      error: { code: 'secret_store_unavailable' },
    });
    await expect(service.test({ id: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists models for saved and unsaved settings', async () => {
    const { connection } = await service.create({
      name: 'Local',
      provider: 'ollama',
      config: { baseUrl: 'http://localhost:11434' },
    });
    expect(await service.listModels({ id: connection.id })).toEqual([{ id: 'm1' }]);
    expect(runner.listModels).toHaveBeenLastCalledWith({
      type: 'connection.listModels',
      connection: expect.objectContaining({
        provider: 'ollama',
        config: { baseUrl: 'http://localhost:11434' },
      }),
    });
    await service.listModels({
      probe: { provider: 'ollama', config: { baseUrl: 'http://gpu-box:11434' } },
    });
    expect(runner.listModels).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ config: { baseUrl: 'http://gpu-box:11434' } }),
      }),
    );
  });
});
