import { useTranslation } from 'react-i18next';
import { PERIODS, localDay, type Period, type PeriodId } from '../../lib/usage';
import { ui } from '../ui';

/** Picks the window the dashboard covers. `custom` reveals two date inputs. */
export function PeriodSelector({
  period,
  onChange,
}: {
  period: Period;
  onChange: (period: Period) => void;
}) {
  const { t } = useTranslation();
  const today = localDay();

  const pick = (id: PeriodId): void => {
    onChange(id === 'custom' ? { id, from: period.from ?? today, to: period.to ?? today } : { id });
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('usage.period.label')}>
        {PERIODS.map((id) => (
          <button
            key={id}
            type="button"
            className={period.id === id ? ui.primary : ui.button}
            aria-pressed={period.id === id}
            data-testid={`usage-period-${id}`}
            onClick={() => pick(id)}
          >
            {t(`usage.period.${id}`)}
          </button>
        ))}
      </div>
      {period.id === 'custom' && (
        <div className="flex items-end gap-2">
          <label className={ui.label}>
            <span className="text-xs">{t('usage.period.from')}</span>
            <input
              type="date"
              className={ui.input}
              data-testid="usage-from"
              value={period.from ?? today}
              max={today}
              onChange={(e) => onChange({ ...period, from: e.target.value })}
            />
          </label>
          <label className={ui.label}>
            <span className="text-xs">{t('usage.period.to')}</span>
            <input
              type="date"
              className={ui.input}
              data-testid="usage-to"
              value={period.to ?? today}
              max={today}
              onChange={(e) => onChange({ ...period, to: e.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
