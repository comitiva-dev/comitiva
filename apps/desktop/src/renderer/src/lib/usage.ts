import type { UsageSummaryRow, UsageTotals } from '@comitiva/contract';

/** A window, with the offset always resolved (the contract's is optional). */
export interface Window {
  from: string;
  to: string;
  tzOffsetMinutes: number;
}

/** The periods the screen offers. `custom` carries its own two days. */
export type PeriodId = 'today' | 'last7' | 'last30' | 'thisMonth' | 'custom';

export const PERIODS: readonly PeriodId[] = ['today', 'last7', 'last30', 'thisMonth', 'custom'];

export interface Period {
  id: PeriodId;
  /** Only for `custom`: inclusive first and last day, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

/** The viewer's offset from UTC, the sign Intl uses (east of UTC is positive). */
export const tzOffsetMinutes = (now = new Date()): number => -now.getTimezoneOffset();

/** A local `YYYY-MM-DD` for an instant. */
export function localDay(at: Date = new Date()): string {
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Turns a period into the half-open UTC window the backend queries with.
 *
 * The user thinks in their own days, the records are stored in UTC, so a day
 * boundary is local midnight expressed as an instant. `to` is the midnight
 * *after* the last day, so "today" includes everything up to now.
 */
export function rangeOf(period: Period, now: Date = new Date()): Window {
  const offset = tzOffsetMinutes(now);
  const today = localDay(now);
  const first =
    period.id === 'today'
      ? today
      : period.id === 'last7'
        ? addDays(today, -6)
        : period.id === 'last30'
          ? addDays(today, -29)
          : period.id === 'thisMonth'
            ? `${today.slice(0, 7)}-01`
            : (period.from ?? today);
  const last = period.id === 'custom' ? (period.to ?? today) : today;
  // A custom range typed backwards is read as the days the user meant.
  const [from, to] = first <= last ? [first, last] : [last, first];
  return {
    from: startOfLocalDay(from, offset),
    to: startOfLocalDay(addDays(to, 1), offset),
    tzOffsetMinutes: offset,
  };
}

/** Local midnight of `day`, as a UTC instant. */
function startOfLocalDay(day: string, offsetMinutes: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const utcMidnight = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Date(utcMidnight - offsetMinutes * 60_000).toISOString();
}

/** `YYYY-MM-DD` shifted by whole days. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** The whole cost of a window: what is billed plus what a plan may absorb. */
export const totalCost = (t: UsageTotals): number => t.costUsd + t.costUsdCli;

/** Every token a window moved, whichever side of the cache it came from. */
export const totalTokens = (t: UsageTotals): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/** How the tables sort: by cost, then by size, so free rows do not lead. */
export function byCostThenTokens(a: UsageSummaryRow, b: UsageSummaryRow): number {
  const cost = totalCost(b) - totalCost(a);
  if (cost !== 0) return cost;
  const tokens = totalTokens(b) - totalTokens(a);
  return tokens !== 0 ? tokens : a.label.localeCompare(b.label);
}

/** The biggest bar in a chart, so every bar can be drawn against it. */
export const peak = (values: readonly number[]): number =>
  values.reduce((a, b) => Math.max(a, b), 0);

/** Nothing ran in the window: the screen shows its empty state. */
export const isEmpty = (t: UsageTotals): boolean => t.runs === 0;
