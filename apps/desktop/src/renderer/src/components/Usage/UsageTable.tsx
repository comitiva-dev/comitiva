import { useTranslation } from 'react-i18next';
import type { UsageSummaryRow } from '@comitiva/contract';
import { money, share, tokens } from '../../lib/format';
import { byCostThenTokens, totalCost, totalTokens } from '../../lib/usage';
import { ui } from '../ui';

/**
 * One grouping of the window. It is a list of rows rather than a `<table>`,
 * matching the other screens, with a bar behind each row showing its share so
 * the ranking reads without comparing numbers.
 */
export function UsageTable({
  title,
  rows,
  testId,
  emptyLabel,
}: {
  title: string;
  rows: UsageSummaryRow[];
  testId: string;
  emptyLabel: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const sorted = [...rows].sort(byCostThenTokens);
  const biggest = sorted.reduce((n, r) => Math.max(n, totalCost(r) || totalTokens(r)), 0);
  const allCost = sorted.reduce((n, r) => n + totalCost(r), 0);

  return (
    <section aria-label={title} data-testid={testId}>
      <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">{title}</h2>
      {sorted.length === 0 ? (
        <p className={`${ui.card} ${ui.muted} p-4 text-center text-sm`}>{emptyLabel}</p>
      ) : (
        <ul className={`${ui.card} divide-y divide-neutral-200 dark:divide-neutral-800`}>
          {sorted.map((row) => {
            const cost = totalCost(row);
            const size = biggest === 0 ? 0 : (cost || totalTokens(row)) / biggest;
            return (
              <li
                key={row.key}
                className="relative flex items-center justify-between gap-3 px-3 py-2"
                data-testid={`${testId}-row`}
                data-name={row.label}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-indigo-500/5 dark:bg-indigo-400/10"
                  style={{ width: `${Math.round(size * 100)}%` }}
                />
                <span className="relative min-w-0 truncate text-sm">
                  {row.deleted ? (
                    <span className={ui.muted}>
                      {row.label === ''
                        ? t('usage.table.deleted')
                        : `${row.label} (${t('usage.table.deletedShort')})`}
                    </span>
                  ) : (
                    row.label
                  )}
                  {row.provider !== null && (
                    <span className={`${ui.muted} ml-2 text-xs`}>{row.provider}</span>
                  )}
                </span>
                <span className="relative flex shrink-0 items-baseline gap-3 text-sm tabular-nums">
                  <span className={`${ui.muted} text-xs`}>
                    {tokens(totalTokens(row), locale)} {t('usage.table.tokens')}
                  </span>
                  <span
                    className="w-20 text-right"
                    title={row.costUsdCli > 0 ? t('usage.equivalent') : undefined}
                    data-testid={`${testId}-cost`}
                  >
                    {money(cost, locale)}
                    {row.costUsdCli > 0 && (
                      <span aria-hidden className={ui.muted}>
                        *
                      </span>
                    )}
                  </span>
                  <span className={`${ui.muted} w-10 text-right text-xs`}>
                    {share(cost, allCost, locale)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
