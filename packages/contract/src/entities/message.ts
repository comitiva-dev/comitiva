import { z } from 'zod';
import { Block } from '../blocks.js';
import { Id, IsoDate } from '../common.js';

export const MessageRole = z.enum(['user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageStatus = z.enum(['streaming', 'complete', 'cancelled', 'error']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const Message = z.object({
  id: Id,
  conversationId: Id,
  role: MessageRole,
  content: z.array(Block),
  status: MessageStatus,
  /** Per-conversation sequence, used for ordering and hub reconciliation. */
  seq: z.number().int().nonnegative(),
  createdAt: IsoDate,
});
export type Message = z.infer<typeof Message>;
