/** Number and date formatting for the Usage screen, in the UI language. */

/** "12,345" — token counts, which are always whole. */
export function tokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** "1.2M" / "12.3k" — for axis ticks and tight cells. */
export function compactTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Money, in US dollars because that is what every provider prices in.
 *
 * A single run often costs a fraction of a cent, and rounding that to $0.00
 * would make a page of real spending look free, so small amounts keep enough
 * decimals to stay visible. Exactly zero stays "$0.00": a local model really
 * is free, and "$0.000000" reads like a rounding artifact.
 */
export function money(value: number, locale: string): string {
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}

/** A `YYYY-MM-DD` bucket as a short label, e.g. "Sep 10". */
export function dayLabel(day: string, locale: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  // Built in UTC and formatted in UTC: the string is already a local day, and
  // re-interpreting it in the viewer's zone would shift it by one.
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(Date.UTC(y, m - 1, d));
}

/** "Sep 10, 2026" — for the ends of the selected period. */
export function dayLabelLong(day: string, locale: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(y, m - 1, d));
}

/** "1.2 s" / "340 ms" — run durations. */
export function duration(ms: number, locale: string): string {
  if (ms < 1000) return `${new Intl.NumberFormat(locale).format(Math.round(ms))} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

/** A share of a total, 0-1, as a percentage. A zero total is zero, not NaN. */
export function share(part: number, total: number, locale: string): string {
  const fraction = total === 0 ? 0 : part / total;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: fraction < 0.1 ? 1 : 0,
  }).format(fraction);
}
