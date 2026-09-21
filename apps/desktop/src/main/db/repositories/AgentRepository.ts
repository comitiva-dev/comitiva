import { isAbsolute } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { Agent, AppError, type ValidAgentDraft, type ValidAgentPatch } from '@comitiva/contract';
import type { Database } from '../Database';
import { agentRoots, agents, agentToolServers } from '../schema';
import { ConnectionRepository } from './ConnectionRepository';

export type NewAgent = ValidAgentDraft & { id?: string };
export type AgentChanges = ValidAgentPatch;

type Row = typeof agents.$inferSelect;

/**
 * Agents in SQLite, with their roots and tool servers loaded and saved
 * together. Every write checks that the agent can run: its connection exists,
 * is enabled, and a model is known for API connections (the agent's, or the
 * connection's default).
 */
export class AgentRepository {
  private readonly connections: ConnectionRepository;

  constructor(private readonly db: Database) {
    this.connections = new ConnectionRepository(db);
  }

  list(): Agent[] {
    const rows = this.db.orm
      .select()
      .from(agents)
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .all();
    const roots = this.db.orm.select().from(agentRoots).orderBy(asc(agentRoots.position)).all();
    const servers = this.db.orm.select().from(agentToolServers).all();
    return rows.map((row) =>
      toAgent(
        row,
        roots.filter((r) => r.agentId === row.id),
        servers.filter((s) => s.agentId === row.id).map((s) => s.toolServerId),
      ),
    );
  }

  get(id: string): Agent | null {
    const row = this.db.orm.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) return null;
    const roots = this.db.orm
      .select()
      .from(agentRoots)
      .where(eq(agentRoots.agentId, id))
      .orderBy(asc(agentRoots.position))
      .all();
    const servers = this.db.orm
      .select()
      .from(agentToolServers)
      .where(eq(agentToolServers.agentId, id))
      .all();
    return toAgent(
      row,
      roots,
      servers.map((s) => s.toolServerId),
    );
  }

  /** Like `get`, but throws `not_found`. */
  require(id: string): Agent {
    const agent = this.get(id);
    if (!agent) throw new AppError('not_found', `Agent ${id} does not exist`);
    return agent;
  }

  create(data: NewAgent): Agent {
    const now = new Date().toISOString();
    const agent = validate({
      ...data,
      id: data.id ?? ulid(),
      fallbackConnectionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    return this.write(() => {
      this.assertUsableConnection(agent.connectionId, agent.model);
      this.db.orm.insert(agents).values(toRow(agent)).run();
      this.replaceLinks(agent);
      return agent;
    });
  }

  /**
   * Applies changes. The connection check runs only when the connection or
   * model change, so an agent whose connection was disabled later can still be
   * renamed or have its role edited.
   */
  update(id: string, changes: AgentChanges): Agent {
    return this.write(() => {
      const current = this.require(id);
      const defined = Object.fromEntries(
        Object.entries(changes).filter(([, v]) => v !== undefined),
      ) as AgentChanges;
      const agent = validate({ ...current, ...defined, updatedAt: new Date().toISOString() });
      if (agent.connectionId !== current.connectionId || agent.model !== current.model) {
        this.assertUsableConnection(agent.connectionId, agent.model);
      }
      this.db.orm.update(agents).set(toRow(agent)).where(eq(agents.id, id)).run();
      if (defined.roots !== undefined || defined.toolServerIds !== undefined) {
        this.replaceLinks(agent);
      }
      return agent;
    });
  }

  /** A copy with a new id, name and timestamps; roots, tools, params and tags included. */
  duplicate(id: string, name: string): Agent {
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      fallbackConnectionIds: _f,
      ...rest
    } = this.require(id);
    return this.create({ ...rest, name });
  }

  /** Deletes the agent; roots, tool server links and conversations cascade. */
  delete(id: string): void {
    this.require(id);
    this.db.orm.delete(agents).where(eq(agents.id, id)).run();
  }

  private assertUsableConnection(connectionId: string, model: string | null): void {
    const record = this.connections.get(connectionId);
    if (!record) {
      throw new AppError('not_found', `Connection ${connectionId} does not exist`);
    }
    const { connection } = record;
    if (!connection.enabled) {
      throw new AppError('connection_disabled', `Connection ${connection.name} is disabled`);
    }
    const defaultModel = (connection.config as { defaultModel?: string }).defaultModel;
    if (connection.kind === 'api' && !model && !defaultModel) {
      throw new AppError(
        'model_required',
        `Connection ${connection.name} has no default model: pick one for the agent`,
      );
    }
  }

  private replaceLinks(agent: Agent): void {
    this.db.orm.delete(agentRoots).where(eq(agentRoots.agentId, agent.id)).run();
    this.db.orm.delete(agentToolServers).where(eq(agentToolServers.agentId, agent.id)).run();
    if (agent.roots.length > 0) {
      this.db.orm
        .insert(agentRoots)
        .values(
          agent.roots.map((r, position) => ({
            agentId: agent.id,
            path: r.path,
            mode: r.mode,
            position,
          })),
        )
        .run();
    }
    if (agent.toolServerIds.length > 0) {
      this.db.orm
        .insert(agentToolServers)
        .values(agent.toolServerIds.map((toolServerId) => ({ agentId: agent.id, toolServerId })))
        .run();
    }
  }

  /** Runs a write in a transaction; unknown tool servers become `invalid_request`. */
  private write<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new AppError('invalid_request', 'Unknown tool server', { cause: err });
      }
      throw err;
    }
  }
}

function validate(candidate: unknown): Agent {
  const parsed = Agent.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError('invalid_request', `Invalid agent: ${parsed.error.issues[0]?.message}`);
  }
  const paths = parsed.data.roots.map((r) => r.path);
  if (new Set(paths).size !== paths.length) {
    throw new AppError('invalid_request', 'Invalid agent: a root is listed twice');
  }
  if (paths.some((p) => !isAbsolute(p))) {
    throw new AppError('invalid_request', 'Invalid agent: roots must be absolute paths');
  }
  return parsed.data;
}

function toRow(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    avatar: a.avatar,
    connectionId: a.connectionId,
    model: a.model,
    role: a.role,
    params: a.params,
    permissionPolicy: a.permissionPolicy,
    fallbackConnectionIds: a.fallbackConnectionIds,
    tags: a.tags,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function toAgent(
  row: Row,
  roots: Array<{ path: string; mode: 'read' | 'readwrite' }>,
  toolServerIds: string[],
): Agent {
  return Agent.parse({
    ...row,
    roots: roots.map((r) => ({ path: r.path, mode: r.mode })),
    toolServerIds,
  });
}
