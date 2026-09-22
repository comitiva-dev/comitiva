import { z } from 'zod';
import { Id, IsoDate } from '../common.js';
import { ProviderId } from '../provider-config.js';

const tokens = z.number().int().nonnegative().nullable();

/** Where `estimatedCostUsd` came from; null when the model has no known price. */
export const CostSource = z.enum(['table', 'override', 'harness']);
export type CostSource = z.infer<typeof CostSource>;

export const UsageRecord = z.object({
  id: Id,
  connectionId: Id,
  agentId: Id,
  conversationId: Id,
  messageId: Id.nullable(),
  /** The connection's provider, kept here so the row survives the connection. */
  provider: ProviderId,
  model: z.string(),
  /** Always net of `cacheReadTokens`: every adapter normalizes to that. */
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
  /** True when tokens were estimated locally instead of reported by the provider. */
  estimated: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  /** `harness`: the CLI harness computed it; a price override never replaces it. */
  costSource: CostSource.nullable(),
  /** True when the cost was computed from estimated tokens. */
  costEstimated: z.boolean(),
  latencyMs: z.number().int().nonnegative().nullable(),
  createdAt: IsoDate,
});
export type UsageRecord = z.infer<typeof UsageRecord>;
