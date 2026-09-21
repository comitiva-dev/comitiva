import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { ApprovalDecision, ToolApproval } from '@comitiva/contract';
import type { Database } from '../Database';
import { toolApprovals } from '../schema';

export type NewToolApproval = Omit<ToolApproval, 'id' | 'decidedAt'> & { decidedAt?: string };

/**
 * The user's answers to tool calls. Every decision is kept (an audit trail
 * per conversation); `allow-always` rows also make later calls of that tool
 * by that agent run without asking.
 */
export class ToolApprovalRepository {
  constructor(private readonly db: Database) {}

  insert(data: NewToolApproval): ToolApproval {
    const row: ToolApproval = {
      id: ulid(),
      conversationId: data.conversationId,
      agentId: data.agentId,
      toolUseId: data.toolUseId,
      toolServerId: data.toolServerId,
      toolName: data.toolName,
      input: data.input ?? null,
      decision: data.decision,
      decidedAt: data.decidedAt ?? new Date().toISOString(),
    };
    this.db.orm.insert(toolApprovals).values(row).run();
    return row;
  }

  /** `${toolServerId}:${toolName}` pairs the agent always allows (the runner's alwaysAllowed). */
  alwaysAllowed(agentId: string): string[] {
    const rows = this.db.orm
      .selectDistinct({ server: toolApprovals.toolServerId, tool: toolApprovals.toolName })
      .from(toolApprovals)
      .where(and(eq(toolApprovals.agentId, agentId), eq(toolApprovals.decision, 'allow-always')))
      .all();
    return rows.map((r) => `${r.server}:${r.tool}`).sort();
  }

  listByConversation(conversationId: string): ToolApproval[] {
    return this.db.orm
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.conversationId, conversationId))
      .all()
      .map((r) => ({ ...r, decision: r.decision as ApprovalDecision }));
  }
}
