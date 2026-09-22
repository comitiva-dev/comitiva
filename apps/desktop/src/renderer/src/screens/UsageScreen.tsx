import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PeriodSelector } from '../components/Usage/PeriodSelector';
import { PriceOverrides } from '../components/Usage/PriceOverrides';
import { UsageChart, type Metric } from '../components/Usage/UsageChart';
import { UsageTable } from '../components/Usage/UsageTable';
import { UsageTotalsCards } from '../components/Usage/UsageTotals';
import { ui } from '../components/ui';
import { isEmpty } from '../lib/usage';
import { useStoreApis, useUsage } from '../store/context';

/** What every call cost, by connection, agent, model and day. */
export function UsageScreen() {
  const { t } = useTranslation();
  const { usage } = useStoreApis();
  const period = useUsage((s) => s.period);
  const summary = useUsage((s) => s.summary);
  const series = useUsage((s) => s.series);
  const notice = useUsage((s) => s.notice);
  const lastExport = useUsage((s) => s.lastExport);
  const [metric, setMetric] = useState<Metric>('tokens');

  // Opening the screen always refetches: runs happen while it is closed, and
  // showing the totals from the last visit would quietly under-report them.
  useEffect(() => {
    const state = usage.getState();
    void state.load();
    if (state.prices.state === 'idle') void state.loadPrices();
  }, [usage]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{t('usage.title')}</h1>
          <p className={`${ui.muted} text-sm`}>{t('usage.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={ui.button}
            data-testid="usage-export-records"
            onClick={() => void usage.getState().exportCsv('records')}
          >
            {t('usage.export.records')}
          </button>
          <button
            type="button"
            className={ui.button}
            data-testid="usage-export-summary"
            onClick={() => void usage.getState().exportCsv('summary')}
          >
            {t('usage.export.summary')}
          </button>
        </div>
      </header>

      <PeriodSelector period={period} onChange={(p) => void usage.getState().setPeriod(p)} />

      {notice !== null && (
        <p className={`${ui.card} ${ui.bad} p-3 text-sm`} data-testid="usage-notice">
          {t(`errors.${notice}`)}
        </p>
      )}
      {lastExport.state === 'failed' && (
        <p className={`${ui.card} ${ui.bad} p-3 text-sm`} data-testid="usage-export-error">
          {t(`errors.${lastExport.code}`)}
        </p>
      )}
      {lastExport.state === 'done' && lastExport.value !== null && (
        <p className={`${ui.card} p-3 text-sm`} data-testid="usage-export-done">
          {t('usage.export.saved', { path: lastExport.value })}
        </p>
      )}

      {summary.state === 'failed' ? (
        <p className={`${ui.card} ${ui.bad} p-4 text-sm`} data-testid="usage-failed">
          {t(`errors.${summary.code}`)}
        </p>
      ) : summary.state !== 'done' ? (
        <p className={`${ui.card} ${ui.muted} p-6 text-center text-sm`} data-testid="usage-loading">
          {t('common.loading')}
        </p>
      ) : (
        <>
          <UsageTotalsCards totals={summary.value.totals} />
          {isEmpty(summary.value.totals) ? (
            <p
              className={`${ui.card} ${ui.muted} p-8 text-center text-sm`}
              data-testid="usage-empty"
            >
              {t('usage.empty')}
            </p>
          ) : (
            <>
              <UsageChart
                series={series.state === 'done' ? series.value : []}
                metric={metric}
                onMetric={setMetric}
              />
              <UsageTable
                title={t('usage.byConnection')}
                rows={summary.value.byConnection}
                testId="usage-by-connection"
                emptyLabel={t('usage.empty')}
              />
              <UsageTable
                title={t('usage.byAgent')}
                rows={summary.value.byAgent}
                testId="usage-by-agent"
                emptyLabel={t('usage.empty')}
              />
              <UsageTable
                title={t('usage.byModel')}
                rows={summary.value.byModel}
                testId="usage-by-model"
                emptyLabel={t('usage.empty')}
              />
            </>
          )}
          <PriceOverrides />
        </>
      )}
    </div>
  );
}
