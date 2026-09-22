import { useTranslation } from 'react-i18next';
import type { UsageTotals as Totals } from '@comitiva/contract';
import { money, tokens } from '../../lib/format';
import { totalTokens } from '../../lib/usage';
import { ui } from '../ui';

/**
 * The headline numbers. Billed cost and CLI-equivalent cost are separate
 * tiles, never one sum: a harness on a subscription may bill none of it, and
 * adding them would produce a figure that matches no invoice.
 */
export function UsageTotalsCards({ totals }: { totals: Totals }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <section
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      aria-label={t('usage.totals.label')}
      data-testid="usage-totals"
    >
      <Card
        label={t('usage.totals.cost')}
        value={money(totals.costUsd, locale)}
        testId="total-cost"
        note={totals.anyUnpriced ? t('usage.totals.unpriced') : undefined}
      />
      <Card
        label={t('usage.totals.costCli')}
        value={money(totals.costUsdCli, locale)}
        testId="total-cost-cli"
        note={totals.costUsdCli > 0 ? t('usage.equivalent') : undefined}
      />
      <Card
        label={t('usage.totals.tokens')}
        value={tokens(totalTokens(totals), locale)}
        testId="total-tokens"
        note={totals.anyEstimated ? t('usage.totals.estimated') : undefined}
      />
      <Card
        label={t('usage.totals.runs')}
        value={tokens(totals.runs, locale)}
        testId="total-runs"
      />
    </section>
  );
}

function Card({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string | undefined;
  testId: string;
}) {
  return (
    <div className={`${ui.card} p-3`} data-testid={testId}>
      <p className={`${ui.muted} text-xs`}>{label}</p>
      <p className="mt-0.5 text-xl tabular-nums" data-testid={`${testId}-value`}>
        {value}
      </p>
      {note !== undefined && (
        <p className={`${ui.muted} mt-0.5 text-[11px]`} data-testid={`${testId}-note`}>
          {note}
        </p>
      )}
    </div>
  );
}
