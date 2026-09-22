import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  UsageRecord,
  type CostSource,
  type ProviderId,
  type UsageBucket,
  type UsageSummaryRow,
  type UsageTotals,
} from '@comitiva/contract';
import type { Database } from '../Database';
import type { Pricing } from '../../usage/Pricing';
import { usageRecords } from '../schema';

export type NewUsageRecord = Omit<
  UsageRecord,
  'id' | 'createdAt' | 'estimatedCostUsd' | 'costSource' | 'costEstimated'
> & {
  createdAt?: string;
  /** A cost the harness computed itself; it wins over the pricing table. */
  reportedCostUsd?: number | null;
};

/** The window a report covers, on the viewer's calendar. */
export interface UsageRange {
  from: string;
  to: string;
  tzOffsetMinutes: number;
}

const ZERO: UsageTotals = {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costUsdCli: 0,
  anyEstimated: false,
  anyUnpriced: false,
};

/**
 * `usage_records` carries no foreign keys: history outlives the agent or
 * connection it belonged to. Aggregates therefore LEFT JOIN for names and the
 * caller labels what is gone.
 *
 * `created_at` is ISO 8601 UTC text. A day on the viewer's calendar is that
 * text shifted by their offset, so the bucket is
 * `substr(datetime(created_at, '±N minutes'), 1, 10)`. The range predicate
 * still compares raw UTC text, which the indexes cover.
 */
const AGGREGATE = `
  count(*) AS runs,
  coalesce(sum(u.input_tokens), 0) AS inputTokens,
  coalesce(sum(u.output_tokens), 0) AS outputTokens,
  coalesce(sum(u.cache_read_tokens), 0) AS cacheReadTokens,
  coalesce(sum(u.cache_write_tokens), 0) AS cacheWriteTokens,
  coalesce(sum(CASE WHEN u.provider IN ('claude-code','codex','gemini-cli') THEN 0 ELSE u.cost_usd END), 0) AS costUsd,
  coalesce(sum(CASE WHEN u.provider IN ('claude-code','codex','gemini-cli') THEN u.cost_usd ELSE 0 END), 0) AS costUsdCli,
  max(u.estimated) AS anyEstimated,
  max(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS anyUnpriced
`;

const WINDOW = `u.created_at >= @from AND u.created_at < @to`;

interface AggregateRow {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costUsdCli: number;
  anyEstimated: number | null;
  anyUnpriced: number | null;
}

const totals = (row: AggregateRow | undefined): UsageTotals =>
  row === undefined || row.runs === 0
    ? { ...ZERO }
    : {
        runs: row.runs,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        costUsd: row.costUsd,
        costUsdCli: row.costUsdCli,
        anyEstimated: row.anyEstimated === 1,
        anyUnpriced: row.anyUnpriced === 1,
      };

/** Token usage, one record per run (replies and titles), and the reports. */
export class UsageRepository {
  constructor(
    private readonly db: Database,
    private readonly pricing?: Pricing,
  ) {}

  /** Cost is computed here, so both writers (replies and titles) get it. */
  insert(data: NewUsageRecord): UsageRecord {
    const { reportedCostUsd, ...fields } = data;
    const cost = this.pricing?.cost(
      fields.provider,
      fields.model,
      {
        inputTokens: fields.inputTokens ?? 0,
        outputTokens: fields.outputTokens ?? 0,
        cacheReadTokens: fields.cacheReadTokens,
        cacheWriteTokens: fields.cacheWriteTokens,
      },
      reportedCostUsd,
    ) ?? { usd: null, source: null };

    const record = UsageRecord.parse({
      ...fields,
      id: ulid(),
      estimatedCostUsd: cost.usd,
      costSource: cost.source,
      // A cost the harness reported is its own measurement, not our arithmetic
      // over estimated tokens, so it is not marked estimated.
      costEstimated: cost.source !== 'harness' && fields.estimated && cost.usd !== null,
      createdAt: data.createdAt ?? new Date().toISOString(),
    });
    const { estimatedCostUsd, ...columns } = record;
    this.db.orm
      .insert(usageRecords)
      .values({ ...columns, costUsd: estimatedCostUsd })
      .run();
    return record;
  }

  listByConversation(conversationId: string): UsageRecord[] {
    return this.db.orm
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.conversationId, conversationId))
      .all()
      .map(({ costUsd, ...row }) => UsageRecord.parse({ ...row, estimatedCostUsd: costUsd }));
  }

  totalsForConversation(conversationId: string): UsageTotals {
    const row = this.db.raw
      .prepare(`SELECT ${AGGREGATE} FROM usage_records u WHERE u.conversation_id = @conversationId`)
      .get({ conversationId }) as AggregateRow | undefined;
    return totals(row);
  }

  totals(range: UsageRange): UsageTotals {
    const row = this.db.raw
      .prepare(`SELECT ${AGGREGATE} FROM usage_records u WHERE ${WINDOW}`)
      .get(range) as AggregateRow | undefined;
    return totals(row);
  }

  /**
   * One row per connection, agent or model in the window, biggest first.
   * `by` decides the grouping; names come from the live rows when they exist.
   */
  groupBy(by: 'connection' | 'agent' | 'model', range: UsageRange): UsageSummaryRow[] {
    const sql =
      by === 'model'
        ? // `key` only has to be unique for the UI; provider and model also
          // travel on their own fields, and no provider id contains a slash.
          `SELECT u.provider || '/' || u.model AS key, u.model AS label, u.provider AS provider,
             0 AS deleted, ${AGGREGATE}
           FROM usage_records u WHERE ${WINDOW}
           GROUP BY u.provider, u.model ORDER BY runs DESC, label ASC`
        : by === 'agent'
          ? `SELECT u.agent_id AS key, coalesce(a.name, '') AS label, NULL AS provider,
               CASE WHEN a.id IS NULL THEN 1 ELSE 0 END AS deleted, ${AGGREGATE}
             FROM usage_records u LEFT JOIN agents a ON a.id = u.agent_id
             WHERE ${WINDOW}
             GROUP BY u.agent_id ORDER BY runs DESC, label ASC`
          : `SELECT u.connection_id AS key, coalesce(c.name, '') AS label,
               coalesce(c.provider, u.provider) AS provider,
               CASE WHEN c.id IS NULL THEN 1 ELSE 0 END AS deleted, ${AGGREGATE}
             FROM usage_records u LEFT JOIN connections c ON c.id = u.connection_id
             WHERE ${WINDOW}
             GROUP BY u.connection_id ORDER BY runs DESC, label ASC`;

    const rows = this.db.raw.prepare(sql).all(range) as Array<
      AggregateRow & { key: string; label: string; provider: string | null; deleted: number }
    >;
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      provider: (row.provider as ProviderId | null) || null,
      deleted: row.deleted === 1,
      ...totals(row),
    }));
  }

  /** One point per day that has runs, oldest first. Gaps are filled by the caller. */
  timeseries(range: UsageRange): UsageBucket[] {
    const rows = this.db.raw
      .prepare(
        `SELECT substr(datetime(u.created_at, @shift), 1, 10) AS day, ${AGGREGATE}
         FROM usage_records u WHERE ${WINDOW}
         GROUP BY day ORDER BY day ASC`,
      )
      .all({ ...range, shift: shiftOf(range.tzOffsetMinutes) }) as Array<
      AggregateRow & { day: string }
    >;
    return rows.map((row) => ({ day: row.day, ...totals(row) }));
  }

  /** Every record in the window, oldest first, for the CSV export. */
  listInRange(range: UsageRange): UsageRecord[] {
    const rows = this.db.raw
      .prepare(`SELECT * FROM usage_records u WHERE ${WINDOW} ORDER BY u.created_at ASC, u.id ASC`)
      .all(range) as Array<Record<string, unknown>>;
    return rows.map((row) => UsageRecord.parse(fromColumns(row)));
  }

  /** Every provider/model pair that has ever been recorded, busiest first. */
  modelsSeen(): Array<{ provider: ProviderId; model: string; runs: number }> {
    return this.db.raw
      .prepare(
        `SELECT provider, model, count(*) AS runs FROM usage_records
         WHERE provider <> '' GROUP BY provider, model ORDER BY runs DESC, model ASC`,
      )
      .all() as Array<{ provider: ProviderId; model: string; runs: number }>;
  }

  /**
   * Recomputes the cost of every record of one model after a price change.
   * Rows whose cost came from the harness are left alone: that number is a
   * measurement, not arithmetic we may redo. Returns how many changed.
   */
  reprice(
    provider: ProviderId,
    model: string,
    cost: (record: UsageRecord) => { usd: number | null; source: CostSource | null },
  ): number {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM usage_records
         WHERE provider = @provider AND model = @model
           AND (cost_source IS NULL OR cost_source <> 'harness')`,
      )
      .all({ provider, model }) as Array<Record<string, unknown>>;

    const update = this.db.raw.prepare(
      `UPDATE usage_records
       SET cost_usd = @costUsd, cost_source = @costSource, cost_estimated = @costEstimated
       WHERE id = @id`,
    );
    return this.db.transaction(() => {
      let changed = 0;
      for (const row of rows) {
        const record = UsageRecord.parse(fromColumns(row));
        const next = cost(record);
        update.run({
          id: record.id,
          costUsd: next.usd,
          costSource: next.source,
          costEstimated: record.estimated && next.usd !== null ? 1 : 0,
        });
        changed += 1;
      }
      return changed;
    });
  }
}

/** A raw row as the `UsageRecord` schema wants it. */
function fromColumns(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    connectionId: row.connection_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    estimated: row.estimated === 1,
    estimatedCostUsd: row.cost_usd,
    costSource: row.cost_source,
    costEstimated: row.cost_estimated === 1,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

/** SQLite's datetime modifier for an offset in minutes. */
function shiftOf(minutes: number): string {
  return `${minutes >= 0 ? '+' : '-'}${Math.abs(minutes)} minutes`;
}
