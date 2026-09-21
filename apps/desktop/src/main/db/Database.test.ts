import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from './Database';

const migrations = join(__dirname, 'migrations');
let db: Database;

afterEach(() => db?.close());

function names(type: 'table' | 'index'): string[] {
  return (
    db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
      .all(type) as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

const now = '2026-01-01T00:00:00.000Z';

describe('Database', () => {
  it('creates every table and index from the initial migration', () => {
    db = Database.open(':memory:');
    db.migrate(migrations);
    expect(names('table')).toEqual(
      expect.arrayContaining([
        'agent_roots',
        'agent_tool_servers',
        'agents',
        'app_settings',
        'connections',
        'conversations',
        'messages',
        'tool_approvals',
        'tool_servers',
        'usage_records',
        '__drizzle_migrations',
      ]),
    );
    expect(names('index')).toEqual(
      expect.arrayContaining([
        'idx_agents_connection',
        'idx_conversations_agent',
        'idx_messages_conv_seq',
        'idx_approvals_always',
        'idx_usage_conn_time',
        'idx_usage_agent_time',
      ]),
    );
  });

  it('is idempotent', () => {
    db = Database.open(':memory:');
    db.migrate(migrations);
    db.migrate(migrations);
    const applied = db.raw.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
      n: number;
    };
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    expect(applied.n).toBe(journal.entries.length);
  });

  it('enforces CHECK constraints and foreign keys', () => {
    db = Database.open(':memory:');
    db.migrate(migrations);
    const insertConn = db.raw.prepare(
      `INSERT INTO connections (id, name, kind, provider, created_at, updated_at) VALUES (?, 'x', ?, 'anthropic', ?, ?)`,
    );
    expect(() => insertConn.run('c1', 'api', now, now)).not.toThrow();
    expect(() => insertConn.run('c2', 'web', now, now)).toThrow(/CHECK/);

    const insertAgent = db.raw.prepare(
      `INSERT INTO agents (id, name, avatar, connection_id, created_at, updated_at) VALUES (?, 'a', '🙂', ?, ?, ?)`,
    );
    expect(() => insertAgent.run('a1', 'missing', now, now)).toThrow(/FOREIGN KEY/);
    insertAgent.run('a1', 'c1', now, now);
    // ON DELETE RESTRICT: a connection in use cannot be removed.
    expect(() => db.raw.prepare(`DELETE FROM connections WHERE id = 'c1'`).run()).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('has no place for secret values', () => {
    db = Database.open(':memory:');
    db.migrate(migrations);
    const cols = db.raw
      .prepare(`SELECT name FROM pragma_table_info('connections')`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('secret_ref');
    expect(cols.map((c) => c.name)).not.toContain('secret');
  });
});
