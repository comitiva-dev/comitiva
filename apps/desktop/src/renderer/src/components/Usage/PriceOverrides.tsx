import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelPrice, ModelPrices } from '@comitiva/contract';
import { errorCode } from '../../backend/Backend';
import { money } from '../../lib/format';
import { useStoreApis, useUsage } from '../../store/context';
import { ui } from '../ui';

/**
 * The prices every recorded model is costed with, and the user's corrections.
 * Saving one recosts that model's past records, so the dashboard never shows
 * two prices for one model.
 */
export function PriceOverrides() {
  const { t } = useTranslation();
  const prices = useUsage((s) => s.prices);
  const [editing, setEditing] = useState<string | null>(null);

  if (prices.state !== 'done' || prices.value.length === 0) return null;

  return (
    <section aria-label={t('usage.prices.title')} data-testid="usage-prices">
      <h2 className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {t('usage.prices.title')}
      </h2>
      <p className={`${ui.muted} mb-2 text-xs`}>{t('usage.prices.hint')}</p>
      <ul className={`${ui.card} divide-y divide-neutral-200 dark:divide-neutral-800`}>
        {prices.value.map((price) => {
          const id = `${price.provider}/${price.model}`;
          return (
            <li key={id} className="px-3 py-2" data-testid="price-row" data-name={price.model}>
              {editing === id ? (
                <PriceForm price={price} onClose={() => setEditing(null)} />
              ) : (
                <PriceRow price={price} onEdit={() => setEditing(id)} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PriceRow({ price, onEdit }: { price: ModelPrice; onEdit: () => void }) {
  const { t, i18n } = useTranslation();
  const { usage } = useStoreApis();
  const locale = i18n.language;
  const per1M = (n: number) => `${money(n, locale)}/M`;

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate text-sm">{price.model}</span>
        <span className={`${ui.muted} text-xs`}>
          {price.provider}
          {price.source === 'override' && ` · ${t('usage.prices.corrected')}`}
          {price.source === 'none' && ` · ${t('usage.prices.unknown')}`}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3 text-sm tabular-nums">
        <span className={ui.muted} data-testid="price-value">
          {price.prices === null
            ? '—'
            : `${per1M(price.prices.inputPer1M)} · ${per1M(price.prices.outputPer1M)}`}
        </span>
        <button type="button" className={ui.ghost} onClick={onEdit} data-testid="price-edit">
          {price.source === 'none' ? t('usage.prices.set') : t('common.edit')}
        </button>
        {price.source === 'override' && (
          <button
            type="button"
            className={ui.ghost}
            data-testid="price-reset"
            onClick={() => void usage.getState().clearPrice(price.provider, price.model)}
          >
            {t('usage.prices.reset')}
          </button>
        )}
      </span>
    </div>
  );
}

function PriceForm({ price, onClose }: { price: ModelPrice; onClose: () => void }) {
  const { t } = useTranslation();
  const { usage } = useStoreApis();
  const [form, setForm] = useState({
    inputPer1M: price.prices ? String(price.prices.inputPer1M) : '',
    outputPer1M: price.prices ? String(price.prices.outputPer1M) : '',
    cacheReadPer1M: price.prices?.cacheReadPer1M != null ? String(price.prices.cacheReadPer1M) : '',
    cacheWritePer1M:
      price.prices?.cacheWritePer1M != null ? String(price.prices.cacheWritePer1M) : '',
  });
  const [problem, setProblem] = useState<string | null>(null);

  const field = (key: keyof typeof form, label: string, required: boolean) => (
    <label className={`${ui.label} flex-1`}>
      <span className="text-xs">
        {label}
        {!required && <span className={ui.hint}> ({t('usage.prices.optional')})</span>}
      </span>
      <input
        className={ui.input}
        inputMode="decimal"
        data-testid={`price-${key}`}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  const submit = async (): Promise<void> => {
    const parsed = parsePrices(form);
    if (parsed === null) {
      setProblem(t('usage.prices.invalid'));
      return;
    }
    try {
      await usage.getState().savePrice(price.provider, price.model, parsed);
      onClose();
    } catch (err) {
      setProblem(t(`errors.${errorCode(err)}`));
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      data-testid="price-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm">
        {price.model} <span className={`${ui.muted} text-xs`}>{t('usage.prices.per1M')}</span>
      </p>
      <div className="flex gap-2">
        {field('inputPer1M', t('usage.tokens.input'), true)}
        {field('outputPer1M', t('usage.tokens.output'), true)}
        {field('cacheReadPer1M', t('usage.tokens.cacheRead'), false)}
        {field('cacheWritePer1M', t('usage.tokens.cacheWrite'), false)}
      </div>
      {problem !== null && <p className={`${ui.bad} text-xs`}>{problem}</p>}
      <div className="flex gap-2">
        <button type="submit" className={ui.primary} data-testid="price-save">
          {t('common.save')}
        </button>
        <button type="button" className={ui.button} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The typed form as prices, or null when a required field is not a number. */
export function parsePrices(form: {
  inputPer1M: string;
  outputPer1M: string;
  cacheReadPer1M: string;
  cacheWritePer1M: string;
}): ModelPrices | null {
  const required = (raw: string): number | null => {
    const n = Number(raw.trim().replace(',', '.'));
    return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const optional = (raw: string): number | null | undefined => {
    if (raw.trim() === '') return null;
    const n = required(raw);
    return n === null ? undefined : n;
  };
  const inputPer1M = required(form.inputPer1M);
  const outputPer1M = required(form.outputPer1M);
  const cacheReadPer1M = optional(form.cacheReadPer1M);
  const cacheWritePer1M = optional(form.cacheWritePer1M);
  if (
    inputPer1M === null ||
    outputPer1M === null ||
    cacheReadPer1M === undefined ||
    cacheWritePer1M === undefined
  ) {
    return null;
  }
  return { inputPer1M, outputPer1M, cacheReadPer1M, cacheWritePer1M };
}
