import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../Database';
import { agents } from '../schema';
import { ConnectionRepository } from './ConnectionRepository';

const migrations = join(__dirname, '..', 'migrations');
let db: Database;
let repo: ConnectionRepository;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  repo = new ConnectionRepository(db);
});
afterEach(() => db.close());

const groq = {
  name: 'Groq',
  provider: 'openai-compatible' as const,
  config: { baseUrl: 'https://api.groq.com/openai/v1', preset: 'groq', defaultModel: 'llama' },
  secretRef: 'connection:x',
};

describe('ConnectionRepository', () => {
  it('creates, lists and gets connections with the kind derived from the provider', () => {
    const a = repo.create({ ...groq, id: '01A' });
    const b = repo.create({
      name: 'Local',
      provider: 'ollama',
      config: {},
      secretRef: null,
      id: '01B',
    });
    expect(a.connection).toMatchObject({
      id: '01A',
      kind: 'api',
      enabled: true,
      secretRef: 'connection:x',
    });
    // Defaults from the provider schema are applied.
    expect(b.connection.config).toEqual({ baseUrl: 'http://localhost:11434' });
    expect(repo.list().map((r) => r.connection.id)).toEqual(['01A', '01B']);
    expect(repo.get('01A')).toEqual(a);
    expect(repo.get('missing')).toBeNull();
    expect(() => repo.require('missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('rejects configs that do not match the provider', () => {
    expect(() =>
      repo.create({ name: 'x', provider: 'openai-compatible', config: {}, secretRef: null }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      repo.create({
        name: 'x',
        provider: 'ollama',
        config: { baseUrl: 'not a url' },
        secretRef: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(repo.list()).toEqual([]);
  });

  it('updates fields, validates the result and keeps createdAt', () => {
    const { connection } = repo.create(groq);
    const updated = repo.update(connection.id, { name: 'Groq 2', enabled: false });
    expect(updated.connection).toMatchObject({
      name: 'Groq 2',
      enabled: false,
      createdAt: connection.createdAt,
    });
    expect(repo.get(connection.id)?.connection.name).toBe('Groq 2');
    expect(() => repo.update(connection.id, { config: { baseUrl: 'nope' } })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => repo.update('missing', { name: 'x' })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('records the last test and clears it when config or key change', () => {
    const { connection } = repo.create(groq);
    const at = new Date('2026-09-18T12:00:00.000Z');
    repo.recordTest(connection.id, { ok: true, latencyMs: 123.4 }, at);
    expect(repo.get(connection.id)?.lastTest).toEqual({
      at: at.toISOString(),
      ok: true,
      latencyMs: 123,
      errorCode: null,
    });

    repo.recordTest(
      connection.id,
      { ok: false, error: { code: 'auth_failed', message: 'no', retryable: false } },
      at,
    );
    expect(repo.get(connection.id)?.lastTest).toMatchObject({
      ok: false,
      latencyMs: null,
      errorCode: 'auth_failed',
    });

    // A rename (even resending the same config) keeps it; a config or key change makes it stale.
    expect(
      repo.update(connection.id, { name: 'renamed', config: connection.config }).lastTest,
    ).not.toBeNull();
    repo.recordTest(connection.id, { ok: true, latencyMs: 1 }, at);
    expect(repo.update(connection.id, { keyChanged: true }).lastTest).toBeNull();
    repo.recordTest(connection.id, { ok: true, latencyMs: 1 }, at);
    expect(
      repo.update(connection.id, { config: { ...groq.config, defaultModel: 'other' } }).lastTest,
    ).toBeNull();
    expect(repo.get(connection.id)?.lastTest).toBeNull();
  });

  it('refuses to delete a connection agents still use', () => {
    const { connection } = repo.create(groq);
    const now = new Date().toISOString();
    db.orm
      .insert(agents)
      .values({
        id: 'ag',
        name: 'A',
        avatar: '🙂',
        connectionId: connection.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(repo.hasAgents(connection.id)).toBe(true);
    expect(() => repo.delete(connection.id)).toThrow(
      expect.objectContaining({ code: 'connection_in_use' }),
    );
    db.raw.prepare('DELETE FROM agents').run();
    repo.delete(connection.id);
    expect(repo.get(connection.id)).toBeNull();
  });

  it('has no column that could hold a secret value', () => {
    const columns = (
      db.raw.prepare('PRAGMA table_info(connections)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('secret_ref');
    expect(columns.filter((c) => /key|secret|token|password/i.test(c))).toEqual(['secret_ref']);
  });
});
