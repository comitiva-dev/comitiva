import { z } from 'zod';
import { Id } from '../common.js';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/** Per-connection limits (Phase 10). */
export const UsagePolicy = z.object({
  connectionId: Id,
  maxTokensDay: z.number().int().positive().nullable(),
  maxCostDay: z.number().positive().nullable(),
  maxConcurrent: z.number().int().positive().nullable(),
  windowStart: timeOfDay.nullable(),
  windowEnd: timeOfDay.nullable(),
});
export type UsagePolicy = z.infer<typeof UsagePolicy>;
