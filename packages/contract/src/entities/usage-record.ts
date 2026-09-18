import { z } from 'zod';
import { Id, IsoDate } from '../common.js';

const tokens = z.number().int().nonnegative().nullable();

export const UsageRecord = z.object({
  id: Id,
  connectionId: Id,
  agentId: Id,
  conversationId: Id,
  messageId: Id.nullable(),
  model: z.string(),
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
  /** True when tokens were estimated locally instead of reported by the provider. */
  estimated: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  createdAt: IsoDate,
});
export type UsageRecord = z.infer<typeof UsageRecord>;
