/**
 * The chart palette, one CSS custom property per role, so light and dark swap
 * in one place and the chart is written against roles instead of hex.
 *
 * The four categorical slots are the reference palette's first four, in its
 * fixed order. That order is the colorblind-safety mechanism, not a taste
 * call: on the adjacent pairlist a stacked bar uses, the worst pair is
 * ΔE 9.1 (light) and 8.4 (dark) under protanopia, clear of the 8 target.
 * Two light-mode slots fall under 3:1 against the surface, which obliges the
 * relief rule — hence the legend and the tables underneath, which are the
 * chart's table view.
 */
export const CHART_VARS = `
.usage-chart {
  --series-input: #2a78d6;
  --series-output: #eb6834;
  --series-cache-read: #1baf7a;
  --series-cache-write: #eda100;
  --series-cost: #2a78d6;
  --chart-grid: #e5e5e5;
  --chart-axis: #737373;
  --chart-surface: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .usage-chart {
    --series-input: #3987e5;
    --series-output: #d95926;
    --series-cache-read: #199e70;
    --series-cache-write: #c98500;
    --series-cost: #3987e5;
    --chart-grid: #333333;
    --chart-axis: #a3a3a3;
    --chart-surface: #171717;
  }
}
:root[data-theme='dark'] .usage-chart {
  --series-input: #3987e5;
  --series-output: #d95926;
  --series-cache-read: #199e70;
  --series-cache-write: #c98500;
  --series-cost: #3987e5;
  --chart-grid: #333333;
  --chart-axis: #a3a3a3;
  --chart-surface: #171717;
}
`;

/** The stacked token series, bottom to top, in the palette's fixed order. */
export const TOKEN_SERIES = [
  { key: 'inputTokens', color: 'var(--series-input)', label: 'input' },
  { key: 'outputTokens', color: 'var(--series-output)', label: 'output' },
  { key: 'cacheReadTokens', color: 'var(--series-cache-read)', label: 'cacheRead' },
  { key: 'cacheWriteTokens', color: 'var(--series-cache-write)', label: 'cacheWrite' },
] as const;

export type TokenSeriesKey = (typeof TOKEN_SERIES)[number]['key'];
