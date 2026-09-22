import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '@comitiva/contract';
import { Database } from '../Database';
import { Pricing } from '../../usage/Pricing';
import { PricingRepository } from './PricingRepository';
import { UsageRepository, type NewUsageRecord, type UsageRange } from './UsageRepository';

const migrations = join(__dirname, '..', 'migrations');
let db: Database;
let repo: UsageRepository;
let prices: PricingRepository;
let pricing: Pricing;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  prices = new PricingRepository(db);
  pricing = new Pricing(prices);
  repo = new UsageRepository(db, pricing);
});
afterEach(() => db.close());

/** Rows carry no foreign keys, so a report works without these; names need them. */
function seedNames(): void {
  db.raw
    .prepare(
      `INSERT INTO connections (id, name, kind, provider, config, enabled, created_at, updated_at)
       VALUES (@id, @name, @kind, @provider, '{}', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    .run({ id: 'conn-a', name: 'Work Anthropic', kind: 'api', provider: 'anthropic' });
  db.raw
    .prepare(
      `INSERT INTO agents (id, name, avatar, connection_id, model, role, params, permission_policy,
         fallback_connection_ids, tags, created_at, updated_at)
       VALUES (@id, @name, '{"color":"blue"}', 'conn-a', 'claude-sonnet-5', '', '{}', 'ask', '[]', '[]',
         '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    .run({ id: 'agent-a', name: 'Researcher' });
}

const record = (over: Partial<NewUsageRecord> = {}): NewUsageRecord => ({
  connectionId: 'conn-a',
  agentId: 'agent-a',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimated: false,
  latencyMs: 500,
  createdAt: '2026-09-10T12:00:00.000Z',
  ...over,
});

const range = (from: string, to: string, tzOffsetMinutes = 0): UsageRange => ({
  from,
  to,
  tzOffsetMinutes,
});

const SEPTEMBER = range('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

describe('writing a record', () => {
  it('costs it from the shipped table as it is written', () => {
    const written = repo.insert(record());
    // Sonnet 5: $2 in, $10 out per million.
    expect(written.estimatedCostUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000, 12);
    expect(written.costSource).toBe('table');
    expect(written.costEstimated).toBe(false);
  });

  it('leaves an unknown model uncosted rather than guessing', () => {
    const written = repo.insert(record({ model: 'some-local-thing', provider: 'google' }));
    expect(written.estimatedCostUsd).toBeNull();
    expect(written.costSource).toBeNull();
  });

  it('prices a CLI harness on the API behind it', () => {
    const written = repo.insert(record({ provider: 'claude-code', model: 'claude-opus-5' }));
    expect(written.estimatedCostUsd).toBeCloseTo((1000 * 5 + 100 * 25) / 1_000_000, 12);
  });
});

describe('aggregating', () => {
  beforeEach(() => {
    seedNames();
    repo.insert(record({ createdAt: '2026-09-10T12:00:00.000Z' }));
    repo.insert(
      record({
        createdAt: '2026-09-11T09:00:00.000Z',
        model: 'claude-opus-5',
        cacheReadTokens: 500,
        estimated: true,
      }),
    );
    // Another agent and connection, on a CLI harness.
    repo.insert(
      record({
        createdAt: '2026-09-11T20:00:00.000Z',
        connectionId: 'conn-gone',
        agentId: 'agent-gone',
        conversationId: 'conv-2',
        provider: 'claude-code',
        model: 'claude-opus-5',
      }),
    );
    // A title run: no message of its own, on the cheap model.
    repo.insert(
      record({
        createdAt: '2026-09-11T20:00:05.000Z',
        messageId: null,
        model: 'claude-haiku-4-5',
        inputTokens: 40,
        outputTokens: 8,
      }),
    );
    // Outside the window, and must never show up.
    repo.insert(record({ createdAt: '2026-08-31T23:59:59.999Z' }));
    repo.insert(record({ createdAt: '2026-10-01T00:00:00.000Z' }));
  });

  it('counts only the runs inside the half-open window', () => {
    expect(repo.totals(SEPTEMBER).runs).toBe(4);
    // `from` is inclusive and `to` exclusive, so a run exactly on `to` is out.
    expect(repo.totals(range('2026-09-10T12:00:00.000Z', '2026-09-11T09:00:00.000Z')).runs).toBe(1);
  });

  it('keeps the equivalent cost of CLI runs out of the billed total', () => {
    const totals = repo.totals(SEPTEMBER);
    expect(totals.costUsdCli).toBeGreaterThan(0);
    expect(totals.costUsd).toBeGreaterThan(0);
    const cli = repo.groupBy('connection', SEPTEMBER).find((r) => r.key === 'conn-gone');
    expect(cli).toMatchObject({ costUsd: 0 });
    expect(cli!.costUsdCli).toBeGreaterThan(0);
  });

  it('flags a window that mixes estimated tokens in', () => {
    expect(repo.totals(SEPTEMBER).anyEstimated).toBe(true);
    expect(
      repo.totals(range('2026-09-10T00:00:00.000Z', '2026-09-11T00:00:00.000Z')).anyEstimated,
    ).toBe(false);
  });

  it('flags a window holding a run nothing could price', () => {
    expect(repo.totals(SEPTEMBER).anyUnpriced).toBe(false);
    repo.insert(record({ createdAt: '2026-09-12T00:00:00.000Z', model: 'mystery' }));
    expect(repo.totals(SEPTEMBER).anyUnpriced).toBe(true);
  });

  it('is all zeroes, not undefined, for a window with nothing in it', () => {
    expect(repo.totals(range('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'))).toEqual({
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
  });

  it('names connections and agents, and marks the ones that are gone', () => {
    const byAgent = repo.groupBy('agent', SEPTEMBER);
    expect(byAgent.find((r) => r.key === 'agent-a')).toMatchObject({
      label: 'Researcher',
      deleted: false,
      runs: 3,
    });
    // History outlives its agent; the row stays and is labelled by the caller.
    expect(byAgent.find((r) => r.key === 'agent-gone')).toMatchObject({ label: '', deleted: true });
    expect(repo.groupBy('connection', SEPTEMBER).find((r) => r.key === 'conn-a')).toMatchObject({
      label: 'Work Anthropic',
      provider: 'anthropic',
      deleted: false,
    });
  });

  it('groups models per provider, so one name on two providers stays apart', () => {
    repo.insert(
      record({
        createdAt: '2026-09-12T00:00:00.000Z',
        provider: 'openai-compatible',
        model: 'claude-opus-5',
      }),
    );
    const rows = repo
      .groupBy('model', SEPTEMBER)
      .filter((r) => r.label === 'claude-opus-5')
      .map((r) => ({ provider: r.provider, runs: r.runs }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { provider: 'anthropic', runs: 1 },
        { provider: 'claude-code', runs: 1 },
        { provider: 'openai-compatible', runs: 1 },
      ]),
    );
  });

  it('shows title runs under their own cheap model', () => {
    expect(
      repo.groupBy('model', SEPTEMBER).find((r) => r.label === 'claude-haiku-4-5'),
    ).toMatchObject({ runs: 1, outputTokens: 8 });
  });

  it('sums the totals of every group back to the window total', () => {
    const totals = repo.totals(SEPTEMBER);
    for (const by of ['connection', 'agent', 'model'] as const) {
      const rows = repo.groupBy(by, SEPTEMBER);
      expect(rows.reduce((n, r) => n + r.runs, 0)).toBe(totals.runs);
      expect(rows.reduce((n, r) => n + r.inputTokens, 0)).toBe(totals.inputTokens);
      expect(rows.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(totals.costUsd, 12);
    }
  });

  it('buckets by day, and orders the days', () => {
    const days = repo.timeseries(SEPTEMBER);
    expect(days.map((d) => d.day)).toEqual(['2026-09-10', '2026-09-11']);
    expect(days.map((d) => d.runs)).toEqual([1, 3]);
  });

  it('buckets on the viewer calendar, not on UTC', () => {
    // 20:00 UTC is already the 12th in Tokyo (+9), and still the 11th in UTC.
    const tokyo = repo.timeseries({ ...SEPTEMBER, tzOffsetMinutes: 540 });
    expect(tokyo.map((d) => [d.day, d.runs])).toEqual([
      ['2026-09-10', 1],
      ['2026-09-11', 1],
      ['2026-09-12', 2],
    ]);
    // And 09:00 UTC on the 11th is still the 10th in Honolulu (-10).
    const honolulu = repo.timeseries({ ...SEPTEMBER, tzOffsetMinutes: -600 });
    expect(honolulu.map((d) => [d.day, d.runs])).toEqual([
      ['2026-09-10', 2],
      ['2026-09-11', 2],
    ]);
  });

  it('exports the window oldest first', () => {
    const rows = repo.listInRange(SEPTEMBER);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.createdAt)).toEqual([...rows.map((r) => r.createdAt)].sort());
    expect(rows[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('lists every model ever recorded, busiest first', () => {
    const seen = repo.modelsSeen();
    expect(seen[0]).toMatchObject({ model: 'claude-sonnet-5' });
    expect(seen.map((s) => `${s.provider}/${s.model}`)).toEqual(
      expect.arrayContaining(['anthropic/claude-sonnet-5', 'claude-code/claude-opus-5']),
    );
  });
});

describe('repricing after a correction', () => {
  /** What `UsageService` passes to `reprice`: the same costing, minus the
   *  harness cost, which reprice never asks about. */
  const costWith = (p: Pricing) => (r: UsageRecord) =>
    p.cost(r.provider, r.model, {
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
    });

  it('recosts the records of that model only', () => {
    const target = repo.insert(record());
    const other = repo.insert(record({ model: 'claude-opus-5' }));

    prices.set('anthropic', 'claude-sonnet-5', {
      inputPer1M: 100,
      outputPer1M: 200,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
    pricing.reload();
    expect(repo.reprice('anthropic', 'claude-sonnet-5', costWith(pricing))).toBe(1);

    const rows = repo.listInRange(SEPTEMBER);
    const after = rows.find((r) => r.id === target.id)!;
    expect(after.estimatedCostUsd).toBeCloseTo((1000 * 100 + 100 * 200) / 1_000_000, 12);
    expect(after.costSource).toBe('override');
    expect(rows.find((r) => r.id === other.id)!.estimatedCostUsd).toBe(other.estimatedCostUsd);
  });

  it('never overwrites a cost the harness measured itself', () => {
    const reported = repo.insert(
      record({ provider: 'claude-code', model: 'claude-opus-5', reportedCostUsd: 0.5 }),
    );
    expect(reported.costSource).toBe('harness');

    prices.set('claude-code', 'claude-opus-5', {
      inputPer1M: 999,
      outputPer1M: 999,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
    pricing.reload();
    expect(repo.reprice('claude-code', 'claude-opus-5', costWith(pricing))).toBe(0);
    expect(repo.listInRange(SEPTEMBER)[0]!.estimatedCostUsd).toBe(0.5);
  });

  it('can price a model the shipped table never knew', () => {
    const written = repo.insert(record({ provider: 'google', model: 'gemini-internal' }));
    expect(written.estimatedCostUsd).toBeNull();

    prices.set('google', 'gemini-internal', {
      inputPer1M: 1,
      outputPer1M: 2,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
    pricing.reload();
    repo.reprice('google', 'gemini-internal', costWith(pricing));
    expect(repo.listInRange(SEPTEMBER)[0]!.estimatedCostUsd).toBeCloseTo(
      (1000 * 1 + 100 * 2) / 1_000_000,
      12,
    );
  });
});

describe('per-conversation totals', () => {
  it('sums one conversation, title runs included', () => {
    repo.insert(record({ conversationId: 'conv-1' }));
    repo.insert(record({ conversationId: 'conv-1', messageId: null, outputTokens: 7 }));
    repo.insert(record({ conversationId: 'conv-2' }));
    expect(repo.totalsForConversation('conv-1')).toMatchObject({ runs: 2, outputTokens: 107 });
    expect(repo.totalsForConversation('nothing-here').runs).toBe(0);
  });
});
