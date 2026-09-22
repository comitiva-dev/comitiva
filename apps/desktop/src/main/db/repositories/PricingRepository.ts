import { eq, and } from 'drizzle-orm';
import type { ModelPrices, ProviderId } from '@comitiva/contract';
import type { ModelPricing } from '@comitiva/runner';
import type { Database } from '../Database';
import { modelPrices } from '../schema';

/**
 * The user's corrections to the prices that ship with the runner. One row per
 * model; no row means the built-in table is in force.
 */
export class PricingRepository {
  constructor(private readonly db: Database) {}

  /** Every override, shaped the way `UsageCalculator` takes them. */
  all(): Partial<Record<ProviderId, Record<string, ModelPricing>>> {
    const out: Partial<Record<ProviderId, Record<string, ModelPricing>>> = {};
    for (const row of this.db.orm.select().from(modelPrices).all()) {
      const provider = row.provider as ProviderId;
      (out[provider] ??= {})[row.model] = {
        in: row.inputPer1M,
        out: row.outputPer1M,
        cacheRead: row.cacheReadPer1M,
        cacheWrite: row.cacheWritePer1M,
      };
    }
    return out;
  }

  set(provider: ProviderId, model: string, prices: ModelPrices): void {
    this.db.orm
      .insert(modelPrices)
      .values({
        provider,
        model,
        inputPer1M: prices.inputPer1M,
        outputPer1M: prices.outputPer1M,
        cacheReadPer1M: prices.cacheReadPer1M,
        cacheWritePer1M: prices.cacheWritePer1M,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [modelPrices.provider, modelPrices.model],
        set: {
          inputPer1M: prices.inputPer1M,
          outputPer1M: prices.outputPer1M,
          cacheReadPer1M: prices.cacheReadPer1M,
          cacheWritePer1M: prices.cacheWritePer1M,
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  }

  clear(provider: ProviderId, model: string): void {
    this.db.orm
      .delete(modelPrices)
      .where(and(eq(modelPrices.provider, provider), eq(modelPrices.model, model)))
      .run();
  }
}
