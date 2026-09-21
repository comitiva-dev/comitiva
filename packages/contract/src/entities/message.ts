import { z } from 'zod';
import { Block } from '../blocks.js';
import { Id, IsoDate } from '../common.js';
import { AppErrorShape } from '../errors.js';

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
  /** Why an assistant message ended in `error`; null otherwise. The UI shows it by code. */
  error: AppErrorShape.nullable().default(null),
});
export type Message = z.infer<typeof Message>;
