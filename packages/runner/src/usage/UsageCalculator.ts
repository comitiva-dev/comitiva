import { z } from 'zod';
import type { ProviderId } from '@comitiva/contract';
import table from './pricing.json' with { type: 'json' };

/**
 * What a model costs, in US dollars per million tokens. `cacheRead` and
 * `cacheWrite` are null when the provider has no such charge (OpenAI does not
 * bill cache writes) or when we do not know it; the calculator then falls back
 * to the input price, which is what the provider bills in that case.
 */
export const ModelPricing = z.object({
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().nullable().default(null),
  cacheWrite: z.number().nonnegative().nullable().default(null),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

export const PricingTable = z.object({
  version: z.number().int().positive(),
  /** When the prices were last read off the providers' pages. */
  updatedAt: z.string(),
  sources: z.record(z.string(), z.string()).default({}),
  /** Providers that bill on another's table: a CLI harness runs that API. */
  aliases: z.record(z.string(), z.string()).default({}),
  /** `provider → model → prices`. The model `*` prices anything unlisted. */
  models: z.record(z.string(), z.record(z.string(), ModelPricing)).default({}),
});
export type PricingTable = z.infer<typeof PricingTable>;

/** The versioned table that ships with the runner. */
export const PRICING: PricingTable = PricingTable.parse(table);

/** Tokens to price. `input` must already be net of `cacheRead`. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null | undefined;
  cacheWriteTokens?: number | null | undefined;
}

export interface CostResult {
  usd: number;
  source: 'table' | 'override';
  /** The key the price was found under, which may be a prefix of `model`. */
  matched: string;
}

const PER_TOKEN = 1_000_000;

/**
 * Turns tokens into dollars. Prices come from the table that ships with the
 * runner, and the user's corrections (`overrides`) win over it.
 *
 * Model ids carry suffixes the table cannot enumerate (`claude-sonnet-5` is
 * also served as `claude-sonnet-5-20260101`), so a miss falls back to the
 * longest listed id the model starts with, then to the provider's `*` entry.
 * A model nothing matches has no cost rather than a wrong one: the UI says so
 * and offers to set a price.
 */
export class UsageCalculator {
  constructor(
    private readonly pricing: PricingTable = PRICING,
    private readonly overrides: Partial<Record<ProviderId, Record<string, ModelPricing>>> = {},
  ) {}

  /** The prices in force for a model, or null when none are known. */
  pricesFor(
    provider: ProviderId,
    model: string,
  ): { prices: ModelPricing; source: 'table' | 'override'; matched: string } | null {
    const override = lookup(this.overrides[provider], model);
    if (override) return { prices: override.prices, source: 'override', matched: override.matched };

    const billedAs = this.pricing.aliases[provider] ?? provider;
    const found = lookup(this.pricing.models[billedAs], model);
    return found ? { prices: found.prices, source: 'table', matched: found.matched } : null;
  }

  cost(provider: ProviderId, model: string, usage: TokenUsage): CostResult | null {
    const found = this.pricesFor(provider, model);
    if (!found) return null;
    const { prices } = found;
    // An unknown cache rate means the provider bills those tokens as input.
    const cacheRead = prices.cacheRead ?? prices.in;
    const cacheWrite = prices.cacheWrite ?? prices.in;
    const usd =
      (usage.inputTokens * prices.in +
        usage.outputTokens * prices.out +
        (usage.cacheReadTokens ?? 0) * cacheRead +
        (usage.cacheWriteTokens ?? 0) * cacheWrite) /
      PER_TOKEN;
    return { usd: round(usd), source: found.source, matched: found.matched };
  }
}

/** Exact id, else the longest listed id it starts with, else the `*` entry. */
function lookup(
  models: Record<string, ModelPricing> | undefined,
  model: string,
): { prices: ModelPricing; matched: string } | null {
  if (!models) return null;
  const exact = models[model];
  if (exact) return { prices: exact, matched: model };

  let best: string | null = null;
  for (const key of Object.keys(models)) {
    if (key === '*' || !model.startsWith(key)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  if (best !== null) return { prices: models[best]!, matched: best };

  const any = models['*'];
  return any ? { prices: any, matched: '*' } : null;
}

/** Sub-cent costs are normal; keep enough digits that they do not vanish. */
function round(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}
