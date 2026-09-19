import { asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  AppError,
  Connection,
  ErrorCode,
  providerKind,
  type ConnectionTestRecord,
  type ProviderId,
  type TestResult,
} from '@comitiva/contract';
import type { Database } from '../Database';
import { agents, connections } from '../schema';

/** A stored connection plus the outcome of its last test. */
export interface ConnectionRecord {
  connection: Connection;
  lastTest: ConnectionTestRecord | null;
}

export interface NewConnection {
  id?: string;
  name: string;
  provider: ProviderId;
  config: Record<string, unknown>;
  enabled?: boolean | undefined;
  secretRef: string | null;
}

export interface ConnectionChanges {
  name?: string | undefined;
  enabled?: boolean | undefined;
  config?: Record<string, unknown> | undefined;
  secretRef?: string | null | undefined;
  /** The stored key value changed (same ref): the last test no longer applies. */
  keyChanged?: boolean | undefined;
}

type Row = typeof connections.$inferSelect;

export const kindOf = (provider: ProviderId): Connection['kind'] => providerKind(provider);

/**
 * Connections in SQLite. Only a `secretRef` is stored, never a secret value;
 * `config` is validated against the provider's schema on every write and read.
 */
export class ConnectionRepository {
  constructor(private readonly db: Database) {}

  list(): ConnectionRecord[] {
    return this.db.orm
      .select()
      .from(connections)
      .orderBy(asc(connections.createdAt), asc(connections.id))
      .all()
      .map(toRecord);
  }

  get(id: string): ConnectionRecord | null {
    const row = this.db.orm.select().from(connections).where(eq(connections.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /** Like `get`, but throws `not_found`. */
  require(id: string): ConnectionRecord {
    const record = this.get(id);
    if (!record) throw new AppError('not_found', `Connection ${id} does not exist`);
    return record;
  }

  create(data: NewConnection): ConnectionRecord {
    const now = new Date().toISOString();
    const connection = validate({
      id: data.id ?? ulid(),
      name: data.name,
      kind: kindOf(data.provider),
      provider: data.provider,
      config: data.config,
      secretRef: data.secretRef,
      enabled: data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });
    this.db.orm.insert(connections).values(toRow(connection)).run();
    return { connection, lastTest: null };
  }

  /** Applies changes; a different config or key clears the last test. */
  update(id: string, changes: ConnectionChanges): ConnectionRecord {
    const current = this.require(id);
    const connection = this.preview(current.connection, changes);
    // A test result no longer applies once the endpoint, model or key change.
    const staleTest =
      JSON.stringify(connection.config) !== JSON.stringify(current.connection.config) ||
      connection.secretRef !== current.connection.secretRef ||
      changes.keyChanged === true;
    this.db.orm
      .update(connections)
      .set({
        ...toRow(connection),
        ...(staleTest ? clearedTest : {}),
      })
      .where(eq(connections.id, id))
      .run();
    return { connection, lastTest: staleTest ? null : current.lastTest };
  }

  /** The connection `changes` would produce, validated, without writing it. */
  preview(current: Connection, changes: ConnectionChanges): Connection {
    return validate({
      ...current,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
      ...(changes.config !== undefined ? { config: changes.config } : {}),
      ...(changes.secretRef !== undefined ? { secretRef: changes.secretRef } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Deletes the row; `connection_in_use` while agents still use it (FK RESTRICT). */
  delete(id: string): void {
    this.require(id);
    if (this.hasAgents(id)) {
      throw new AppError('connection_in_use', `Connection ${id} is used by agents`);
    }
    this.db.orm.delete(connections).where(eq(connections.id, id)).run();
  }

  hasAgents(id: string): boolean {
    return (
      this.db.orm
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.connectionId, id))
        .limit(1)
        .get() !== undefined
    );
  }

  recordTest(id: string, result: TestResult, at = new Date()): ConnectionTestRecord {
    const record: ConnectionTestRecord = {
      at: at.toISOString(),
      ok: result.ok,
      latencyMs: result.ok ? result.latencyMs : null,
      errorCode: result.ok ? null : result.error.code,
    };
    this.db.orm
      .update(connections)
      .set({
        lastTestAt: record.at,
        lastTestOk: record.ok,
        lastTestLatencyMs: record.latencyMs === null ? null : Math.round(record.latencyMs),
        lastTestErrorCode: record.errorCode,
      })
      .where(eq(connections.id, id))
      .run();
    return record;
  }
}

const clearedTest = {
  lastTestAt: null,
  lastTestOk: null,
  lastTestLatencyMs: null,
  lastTestErrorCode: null,
};

function validate(candidate: unknown): Connection {
  const parsed = Connection.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError('invalid_request', `Invalid connection: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

function toRow(c: Connection) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    provider: c.provider,
    config: c.config,
    secretRef: c.secretRef,
    enabled: c.enabled,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function toRecord(row: Row): ConnectionRecord {
  const connection = Connection.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    config: row.config,
    secretRef: row.secretRef,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const lastTest: ConnectionTestRecord | null =
    row.lastTestAt === null || row.lastTestOk === null
      ? null
      : {
          at: row.lastTestAt,
          ok: row.lastTestOk,
          latencyMs: row.lastTestLatencyMs,
          errorCode:
            row.lastTestErrorCode === null
              ? null
              : (ErrorCode.safeParse(row.lastTestErrorCode).data ?? 'internal'),
        };
  return { connection, lastTest };
}
