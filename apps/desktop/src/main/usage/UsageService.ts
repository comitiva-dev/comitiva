import { writeFile } from 'node:fs/promises';
import {
  AppError,
  providerKind,
  type ModelPrice,
  type ModelPrices,
  type ProviderId,
  type UsageBucket,
  type UsageSummary,
  type UsageTotals,
} from '@comitiva/contract';
import type { PricingRepository } from '../db/repositories/PricingRepository';
import type { UsageRange, UsageRepository } from '../db/repositories/UsageRepository';
import type { Database } from '../db/Database';
import type { Pricing } from './Pricing';
import { toCsv } from './csv';

export interface UsageServiceDeps {
  db: Database;
  usage: UsageRepository;
  prices: PricingRepository;
  pricing: Pricing;
  /** Where the CSV goes; null when the user cancels the save dialog. */
  saveFile(suggestedName: string, contents: string): Promise<string | null>;
}

const DAY_MS = 86_400_000;

/** Reports over `usage_records`, and the prices they are costed with. */
export class UsageService {
  constructor(private readonly deps: UsageServiceDeps) {}

  summary(range: UsageRange): UsageSummary {
    const { usage } = this.deps;
    return {
      totals: usage.totals(range),
      byConnection: usage.groupBy('connection', range),
      byAgent: usage.groupBy('agent', range),
      byModel: usage.groupBy('model', range),
    };
  }

  /**
   * One point per day in the window, including the days nothing ran — a chart
   * with holes in it reads as missing data rather than as a quiet day.
   */
  timeseries(range: UsageRange): UsageBucket[] {
    const found = new Map(this.deps.usage.timeseries(range).map((b) => [b.day, b]));
    const out: UsageBucket[] = [];
    for (const day of daysIn(range)) {
      out.push(found.get(day) ?? { day, ...empty() });
    }
    return out;
  }

  conversation(conversationId: string): UsageTotals {
    return this.deps.usage.totalsForConversation(conversationId);
  }

  /** Every model ever recorded, with the price in force and where it came from. */
  prices(): ModelPrice[] {
    return this.deps.usage.modelsSeen().map(({ provider, model, runs }) => {
      const found = this.deps.pricing.pricesFor(provider, model);
      return {
        provider,
        model,
        prices: found?.prices ?? null,
        source: found?.source ?? 'none',
        runs,
      };
    });
  }

  /**
   * Corrects a model's price and recosts its records, so the dashboard never
   * mixes two prices for one model. Costs the harness reported are kept.
   */
  setPrice(provider: ProviderId, model: string, prices: ModelPrices): ModelPrice[] {
    this.deps.prices.set(provider, model, prices);
    return this.afterPriceChange(provider, model);
  }

  clearPrice(provider: ProviderId, model: string): ModelPrice[] {
    this.deps.prices.clear(provider, model);
    return this.afterPriceChange(provider, model);
  }

  private afterPriceChange(provider: ProviderId, model: string): ModelPrice[] {
    this.deps.pricing.reload();
    this.deps.usage.reprice(provider, model, (record) =>
      this.deps.pricing.cost(record.provider, record.model, {
        inputTokens: record.inputTokens ?? 0,
        outputTokens: record.outputTokens ?? 0,
        cacheReadTokens: record.cacheReadTokens,
        cacheWriteTokens: record.cacheWriteTokens,
      }),
    );
    return this.prices();
  }

  /** Writes a CSV where the user picks; null when they cancel. */
  async export(range: UsageRange, shape: 'records' | 'summary'): Promise<string | null> {
    const day = range.from.slice(0, 10);
    const name = `comitiva-usage-${shape}-${day}.csv`;
    const contents = shape === 'records' ? this.recordsCsv(range) : this.summaryCsv(range);
    const path = await this.deps.saveFile(name, contents);
    if (path === null) return null;
    try {
      await writeFile(path, contents, 'utf8');
    } catch (err) {
      throw new AppError('internal', `Could not write ${path}`, { cause: err });
    }
    return path;
  }

  private recordsCsv(range: UsageRange): string {
    const rows = this.deps.usage.listInRange(range).map((r) => [
      r.createdAt,
      r.provider,
      r.model,
      r.connectionId,
      r.agentId,
      r.conversationId,
      // A title run has no message of its own; saying so beats a blank cell.
      r.messageId ?? '(title)',
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWriteTokens,
      r.estimated,
      r.estimatedCostUsd,
      r.costSource ?? '',
      providerKind(r.provider) === 'cli' ? 'equivalent' : 'billed',
      r.latencyMs,
    ]);
    return toCsv(
      [
        'created_at',
        'provider',
        'model',
        'connection_id',
        'agent_id',
        'conversation_id',
        'message_id',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'tokens_estimated',
        'cost_usd',
        'cost_source',
        'cost_basis',
        'latency_ms',
      ],
      rows,
    );
  }

  private summaryCsv(range: UsageRange): string {
    const summary = this.summary(range);
    const rows: Array<Array<string | number | boolean | null>> = [
      ['total', '', '', ...totalCells(summary.totals)],
    ];
    const groups = [
      ['connection', summary.byConnection],
      ['agent', summary.byAgent],
      ['model', summary.byModel],
    ] as const;
    for (const [group, list] of groups) {
      for (const row of list) {
        rows.push([
          group,
          row.deleted ? `${row.label} (deleted)` : row.label,
          row.provider ?? '',
          ...totalCells(row),
        ]);
      }
    }
    for (const bucket of this.timeseries(range)) {
      rows.push(['day', bucket.day, '', ...totalCells(bucket)]);
    }
    return toCsv(
      [
        'group',
        'name',
        'provider',
        'runs',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'cost_usd',
        'cost_usd_cli_equivalent',
        'tokens_estimated',
        'any_unpriced',
      ],
      rows,
    );
  }
}

const totalCells = (t: UsageTotals): Array<string | number | boolean> => [
  t.runs,
  t.inputTokens,
  t.outputTokens,
  t.cacheReadTokens,
  t.cacheWriteTokens,
  t.costUsd,
  t.costUsdCli,
  t.anyEstimated,
  t.anyUnpriced,
];

const empty = (): UsageTotals => ({
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costUsdCli: 0,
  anyEstimated: false,
  anyUnpriced: false,
});

/**
 * Every day the window covers, on the viewer's calendar. Walking UTC
 * midnights shifted by the offset keeps this in step with the SQL bucket.
 */
function daysIn(range: UsageRange): string[] {
  const shift = range.tzOffsetMinutes * 60_000;
  const first = Date.parse(range.from) + shift;
  const last = Date.parse(range.to) + shift;
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return [];
  const days: string[] = [];
  let cursor = Math.floor(first / DAY_MS) * DAY_MS;
  // A window is closed-open, so a `to` that lands exactly on midnight belongs
  // to the previous day.
  for (; cursor < last && days.length < 3660; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}
