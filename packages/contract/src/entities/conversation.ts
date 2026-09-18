import { z } from 'zod';
import { Id, IsoDate } from '../common.js';

export const ConversationStatus = z.enum(['idle', 'running', 'awaiting-approval', 'error']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const Conversation = z.object({
  id: Id,
  agentId: Id,
  title: z.string().nullable(),
  status: ConversationStatus,
  harnessSessionId: z.string().nullable(),
  archived: z.boolean(),
  lastActivityAt: IsoDate,
  createdAt: IsoDate,
});
export type Conversation = z.infer<typeof Conversation>;
