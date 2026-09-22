import { providerKind, type ModelPrices, type ProviderId } from '@comitiva/contract';
import { PRICING, UsageCalculator, type TokenUsage } from '@comitiva/runner';
import type { PricingRepository } from '../db/repositories/PricingRepository';

export interface Cost {
  usd: number | null;
  source: 'table' | 'override' | 'harness' | null;
}

/**
 * Prices a run. The table ships with the runner (one versioned artifact the
 * Laravel hub can read too); the user's corrections come from SQLite and win
 * over it. The calculator is rebuilt whenever a correction changes, which is
 * rare — runs read it on every write.
 */
export class Pricing {
  private calculator: UsageCalculator;

  constructor(private readonly overrides: PricingRepository) {
    this.calculator = new UsageCalculator(PRICING, overrides.all());
  }

  /** Call after writing to `model_prices`. */
  reload(): void {
    this.calculator = new UsageCalculator(PRICING, this.overrides.all());
  }

  /**
   * What a run cost. A cost the harness computed itself is authoritative —
   * it knows the plan and the models its subagents used — so it is taken as
   * given and marked `harness`, which keeps a later price correction from
   * overwriting it.
   */
  cost(
    provider: ProviderId,
    model: string,
    usage: TokenUsage,
    reportedCostUsd?: number | null,
  ): Cost {
    if (reportedCostUsd !== undefined && reportedCostUsd !== null) {
      return { usd: reportedCostUsd, source: 'harness' };
    }
    const computed = this.calculator.cost(provider, model, usage);
    return computed ? { usd: computed.usd, source: computed.source } : { usd: null, source: null };
  }

  /** The prices in force for a model, for the Prices table on the Usage screen. */
  pricesFor(
    provider: ProviderId,
    model: string,
  ): { prices: ModelPrices; source: 'table' | 'override' } | null {
    const found = this.calculator.pricesFor(provider, model);
    if (!found) return null;
    return {
      source: found.source,
      prices: {
        inputPer1M: found.prices.in,
        outputPer1M: found.prices.out,
        cacheReadPer1M: found.prices.cacheRead,
        cacheWritePer1M: found.prices.cacheWrite,
      },
    };
  }
}

/**
 * Whether a provider's cost is a real bill or an equivalent. CLI harnesses
 * usually run on a subscription, so their tokens are priced at the API's list
 * rates and the UI has to say the plan may bill differently.
 */
export const isEquivalentCost = (provider: ProviderId): boolean => providerKind(provider) === 'cli';
