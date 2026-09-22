import { describe, expect, it } from 'vitest';
import { usageRow, usageTotals } from '../store/testBackend';
import {
  addDays,
  byCostThenTokens,
  isEmpty,
  localDay,
  peak,
  rangeOf,
  totalCost,
  totalTokens,
  tzOffsetMinutes,
} from './usage';

/** Midday in Lisbon on 22 September 2026, wherever the test machine is. */
const NOW = new Date('2026-09-22T12:00:00.000Z');

describe('rangeOf', () => {
  const offset = tzOffsetMinutes(NOW);
  /** The window a period covers, in whole local days. */
  const days = (from: string, to: string) =>
    Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

  it('covers exactly one day for today, ending at the next local midnight', () => {
    const range = rangeOf({ id: 'today' }, NOW);
    expect(days(range.from, range.to)).toBe(1);
    expect(Date.parse(range.to)).toBeGreaterThan(NOW.getTime());
    expect(Date.parse(range.from)).toBeLessThanOrEqual(NOW.getTime());
    expect(range.tzOffsetMinutes).toBe(offset);
  });

  it('counts the last 7 and 30 days inclusive of today', () => {
    expect(days(rangeOf({ id: 'last7' }, NOW).from, rangeOf({ id: 'last7' }, NOW).to)).toBe(7);
    expect(days(rangeOf({ id: 'last30' }, NOW).from, rangeOf({ id: 'last30' }, NOW).to)).toBe(30);
  });

  it('starts this month on its first day', () => {
    const range = rangeOf({ id: 'thisMonth' }, NOW);
    expect(days(range.from, range.to)).toBe(22);
  });

  it('makes a custom range half-open around the days the user picked', () => {
    const range = rangeOf({ id: 'custom', from: '2026-09-01', to: '2026-09-03' }, NOW);
    expect(days(range.from, range.to)).toBe(3);
  });

  it('reads a custom range typed backwards as the days meant', () => {
    const forwards = rangeOf({ id: 'custom', from: '2026-09-01', to: '2026-09-03' }, NOW);
    const backwards = rangeOf({ id: 'custom', from: '2026-09-03', to: '2026-09-01' }, NOW);
    expect(backwards).toEqual(forwards);
  });

  it('falls back to today when a custom range has no days yet', () => {
    expect(rangeOf({ id: 'custom' }, NOW)).toEqual(rangeOf({ id: 'today' }, NOW));
  });

  it('lines the window up with local midnight, not UTC midnight', () => {
    const range = rangeOf({ id: 'today' }, NOW);
    // Shifted back into local time, the boundary is exactly midnight.
    const localStart = Date.parse(range.from) + range.tzOffsetMinutes * 60_000;
    expect(localStart % 86_400_000).toBe(0);
  });
});

describe('addDays and localDay', () => {
  it('crosses months and years', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('gives a plain YYYY-MM-DD', () => {
    expect(localDay(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('totals', () => {
  it('adds billed and equivalent cost only when a whole is wanted', () => {
    const t = usageTotals({ costUsd: 2, costUsdCli: 3 });
    expect(totalCost(t)).toBe(5);
  });

  it('counts cache tokens as tokens moved', () => {
    expect(
      totalTokens(
        usageTotals({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8 }),
      ),
    ).toBe(15);
  });

  it('knows an empty window from a free one', () => {
    expect(isEmpty(usageTotals())).toBe(true);
    expect(isEmpty(usageTotals({ runs: 3 }))).toBe(false);
  });
});

describe('byCostThenTokens', () => {
  it('puts the most expensive row first', () => {
    const rows = [
      usageRow({ label: 'cheap', costUsd: 1 }),
      usageRow({ label: 'dear', costUsd: 9 }),
    ];
    expect([...rows].sort(byCostThenTokens).map((r) => r.label)).toEqual(['dear', 'cheap']);
  });

  it('ranks a CLI row by its equivalent cost, not as free', () => {
    const rows = [
      usageRow({ label: 'api', costUsd: 1 }),
      usageRow({ label: 'harness', costUsdCli: 9 }),
    ];
    expect([...rows].sort(byCostThenTokens).map((r) => r.label)).toEqual(['harness', 'api']);
  });

  it('falls back to tokens, then to the name, so the order never wobbles', () => {
    const rows = [
      usageRow({ label: 'b', inputTokens: 5 }),
      usageRow({ label: 'a', inputTokens: 5 }),
      usageRow({ label: 'c', inputTokens: 50 }),
    ];
    expect([...rows].sort(byCostThenTokens).map((r) => r.label)).toEqual(['c', 'a', 'b']);
  });
});

describe('peak', () => {
  it('is zero for nothing, so a chart of an empty window still renders', () => {
    expect(peak([])).toBe(0);
    expect(peak([1, 9, 3])).toBe(9);
  });
});
