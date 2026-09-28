import { eq } from 'drizzle-orm';
import { AgentLink, type AgentLink as AgentLinkT } from '@comitiva/contract';
import type { Database } from '../Database';
import { hubAgentLinks, hubAlwaysAllowed, hubHarnessSessions } from '../schema';

/**
 * What this desktop keeps about hub workspaces (ADR 0017): how it runs each
 * shared agent (its links), harness sessions and allow-always decisions.
 * None of it is sent to the hub.
 */
export class HubLocalRepository {
  constructor(private readonly db: Database) {}

  links(workspaceId: string): AgentLinkT[] {
    return this.db.orm
      .select()
      .from(hubAgentLinks)
      .where(eq(hubAgentLinks.workspaceId, workspaceId))
      .all()
      .map(toLink);
  }

  link(agentId: string): AgentLinkT | null {
    const row = this.db.orm
      .select()
      .from(hubAgentLinks)
      .where(eq(hubAgentLinks.agentId, agentId))
      .get();
    return row ? toLink(row) : null;
  }

  /** Roots must be absolute, as for local agents. */
  setLink(link: AgentLinkT): AgentLinkT {
    const valid = AgentLink.parse(link);
    const values = {
      agentId: valid.agentId,
      workspaceId: valid.workspaceId,
      connectionId: valid.connectionId,
      roots: valid.roots,
      toolServerIds: valid.toolServerIds,
      updatedAt: new Date().toISOString(),
    };
    this.db.orm
      .insert(hubAgentLinks)
      .values(values)
      .onConflictDoUpdate({ target: hubAgentLinks.agentId, set: values })
      .run();
    return valid;
  }

  harnessSession(conversationId: string, connectionId: string): string | undefined {
    const row = this.db.orm
      .select()
      .from(hubHarnessSessions)
      .where(eq(hubHarnessSessions.conversationId, conversationId))
      .get();
    return row && row.connectionId === connectionId ? row.harnessSessionId : undefined;
  }

  setHarnessSession(conversationId: string, harnessSessionId: string, connectionId: string): void {
    this.db.orm
      .insert(hubHarnessSessions)
      .values({ conversationId, harnessSessionId, connectionId })
      .onConflictDoUpdate({
        target: hubHarnessSessions.conversationId,
        set: { harnessSessionId, connectionId },
      })
      .run();
  }

  /** `${toolServerId}:${toolName}` pairs, as run.start wants them. */
  alwaysAllowed(agentId: string): string[] {
    return this.db.orm
      .select()
      .from(hubAlwaysAllowed)
      .where(eq(hubAlwaysAllowed.agentId, agentId))
      .all()
      .map((r) => `${r.toolServerId}:${r.toolName}`);
  }

  allowAlways(agentId: string, toolServerId: string, toolName: string): void {
    this.db.orm
      .insert(hubAlwaysAllowed)
      .values({ agentId, toolServerId, toolName, decidedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  forgetAgent(agentId: string): void {
    this.db.transaction(() => {
      this.db.orm.delete(hubAgentLinks).where(eq(hubAgentLinks.agentId, agentId)).run();
      this.db.orm.delete(hubAlwaysAllowed).where(eq(hubAlwaysAllowed.agentId, agentId)).run();
    });
  }
}

function toLink(row: typeof hubAgentLinks.$inferSelect): AgentLinkT {
  return {
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    roots: AgentLink.shape.roots.parse(row.roots),
    toolServerIds: AgentLink.shape.toolServerIds.parse(row.toolServerIds),
  };
}
