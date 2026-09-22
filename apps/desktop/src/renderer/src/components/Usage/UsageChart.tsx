import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { UsageBucket } from '@comitiva/contract';
import { compactTokens, dayLabel, money, tokens } from '../../lib/format';
import { totalCost } from '../../lib/usage';
import { ui } from '../ui';
import { CHART_VARS, TOKEN_SERIES } from './palette';

export type Metric = 'tokens' | 'cost';

/**
 * Usage by day. Tokens and cost are never drawn together: they are different
 * scales, and a chart with two y-axes invites reading a crossing as a
 * relationship it does not have. The toggle shows one at a time.
 */
export function UsageChart({
  series,
  metric,
  onMetric,
}: {
  series: UsageBucket[];
  metric: Metric;
  onMetric: (metric: Metric) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const data = series.map((b) => ({ ...b, cost: totalCost(b) }));
  const empty = data.every((b) => (metric === 'tokens' ? b.runs === 0 : b.cost === 0));

  return (
    <section className={`${ui.card} usage-chart p-4`} aria-label={t('usage.chart.label')}>
      <style>{CHART_VARS}</style>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {t('usage.chart.title')}
        </h2>
        <div
          className="flex gap-1"
          role="group"
          aria-label={t('usage.chart.metric')}
          data-testid="usage-metric"
        >
          {(['tokens', 'cost'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={metric === id ? ui.primary : ui.button}
              aria-pressed={metric === id}
              data-testid={`usage-metric-${id}`}
              onClick={() => onMetric(id)}
            >
              {t(`usage.metric.${id}`)}
            </button>
          ))}
        </div>
      </header>

      {empty ? (
        <p className={`${ui.muted} py-10 text-center text-sm`} data-testid="usage-chart-empty">
          {t('usage.chart.empty')}
        </p>
      ) : (
        <>
          <div className="h-56" data-testid="usage-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tickFormatter={(day: string) => dayLabel(day, locale)}
                  stroke="var(--chart-axis)"
                  tickLine={false}
                  fontSize={11}
                  minTickGap={16}
                />
                <YAxis
                  stroke="var(--chart-axis)"
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  width={52}
                  tickFormatter={(n: number) =>
                    metric === 'tokens' ? compactTokens(n, locale) : money(n, locale)
                  }
                />
                <Tooltip
                  cursor={{ fill: 'var(--chart-grid)', fillOpacity: 0.35 }}
                  content={({ active, label, payload }) => (
                    <ChartTooltip
                      active={active === true}
                      label={label}
                      payload={payload ?? []}
                      metric={metric}
                    />
                  )}
                />
                {metric === 'tokens' ? (
                  TOKEN_SERIES.map((s, i) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      stackId="tokens"
                      fill={s.color}
                      // A 2px surface gap keeps adjacent segments legible, and
                      // only the top of the stack is rounded.
                      stroke="var(--chart-surface)"
                      strokeWidth={2}
                      radius={i === TOKEN_SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                      isAnimationActive={false}
                    />
                  ))
                ) : (
                  <Bar
                    dataKey="cost"
                    fill="var(--series-cost)"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {metric === 'tokens' && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1" data-testid="usage-legend">
              {TOKEN_SERIES.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5 text-xs">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: s.color }}
                  />
                  <span className={ui.muted}>{t(`usage.tokens.${s.label}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

interface TooltipProps {
  active: boolean;
  label: unknown;
  /** Recharts types `dataKey` loosely (it may be an accessor); we only set strings. */
  payload: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>;
  metric: Metric;
}

function ChartTooltip({ active, label, payload, metric }: TooltipProps) {
  const { t, i18n } = useTranslation();
  if (!active || payload.length === 0) return null;
  const locale = i18n.language;
  return (
    <div className={`${ui.card} px-3 py-2 text-xs shadow-md`}>
      <p className="mb-1 font-medium">{dayLabel(String(label ?? ''), locale)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        {payload.map((entry) => {
          const series = TOKEN_SERIES.find((s) => s.key === entry.dataKey);
          const key = String(entry.dataKey ?? '');
          return (
            <div key={key} className="contents">
              <dt className={ui.muted}>
                {series ? t(`usage.tokens.${series.label}`) : t('usage.metric.cost')}
              </dt>
              <dd className="text-right tabular-nums">
                {metric === 'tokens'
                  ? tokens(Number(entry.value ?? 0), locale)
                  : money(Number(entry.value ?? 0), locale)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
