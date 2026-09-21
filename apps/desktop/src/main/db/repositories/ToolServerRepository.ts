import { asc, desc, eq } from 'drizzle-orm';
import { AppError, ToolServer, type ValueOrSecret } from '@comitiva/contract';
import type { Database } from '../Database';
import { toolServers } from '../schema';

export interface NewToolServer {
  id: string;
  name: string;
  transport: ToolServer['transport'];
  command: string | null;
  args: string[];
  env: Record<string, ValueOrSecret>;
  url: string | null;
  headers: Record<string, ValueOrSecret>;
  enabled: boolean;
}

export type ToolServerChanges = Partial<Omit<NewToolServer, 'id'>>;

type Row = typeof toolServers.$inferSelect;

/**
 * MCP servers in SQLite. Env and header values are either plain values or a
 * `secretRef` (the SecretStore holds the value). Built-ins are seeded by
 * migration and cannot be deleted. Every row is validated by the ToolServer
 * schema on read and write.
 */
export class ToolServerRepository {
  constructor(private readonly db: Database) {}

  /** Built-ins first, then by creation. */
  list(): ToolServer[] {
    return this.db.orm
      .select()
      .from(toolServers)
      .orderBy(desc(toolServers.builtin), asc(toolServers.createdAt), asc(toolServers.id))
      .all()
      .map(toToolServer);
  }

  get(id: string): ToolServer | null {
    const row = this.db.orm.select().from(toolServers).where(eq(toolServers.id, id)).get();
    return row ? toToolServer(row) : null;
  }

  require(id: string): ToolServer {
    const server = this.get(id);
    if (!server) throw new AppError('not_found', `Tool server ${id} not found`);
    return server;
  }

  create(data: NewToolServer): ToolServer {
    const server = ToolServer.parse({
      ...data,
      builtin: false,
      createdAt: new Date().toISOString(),
    });
    this.db.orm.insert(toolServers).values(server).run();
    return server;
  }

  update(id: string, changes: ToolServerChanges): ToolServer {
    const next = ToolServer.parse({ ...this.require(id), ...changes });
    this.db.orm
      .update(toolServers)
      .set({
        name: next.name,
        transport: next.transport,
        command: next.command,
        args: next.args,
        env: next.env,
        url: next.url,
        headers: next.headers,
        enabled: next.enabled,
      })
      .where(eq(toolServers.id, id))
      .run();
    return next;
  }

  /** Agents lose the link by cascade. */
  delete(id: string): void {
    const server = this.require(id);
    if (server.builtin) throw new AppError('invalid_request', 'Built-in servers cannot be deleted');
    this.db.orm.delete(toolServers).where(eq(toolServers.id, id)).run();
  }
}

function toToolServer(row: Row): ToolServer {
  return ToolServer.parse({
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: row.args,
    env: row.env,
    url: row.url,
    headers: row.headers,
    builtin: row.builtin,
    enabled: row.enabled,
    createdAt: row.createdAt,
  });
}
