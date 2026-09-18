import { z } from 'zod';
import { Id, IsoDate } from '../common.js';

export const ApprovalDecision = z.enum(['allow', 'deny', 'allow-always']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ToolApproval = z.object({
  id: Id,
  conversationId: Id,
  agentId: Id,
  toolUseId: z.string(),
  toolServerId: Id,
  toolName: z.string(),
  input: z.unknown(),
  decision: ApprovalDecision,
  decidedAt: IsoDate,
});
export type ToolApproval = z.infer<typeof ToolApproval>;
