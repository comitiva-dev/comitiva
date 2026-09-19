import { useEffect, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  apiProviderIds,
  cliProviderIds,
  cliProviderDescriptors,
  providerDescriptors,
  type ErrorCode,
  type OpenAICompatiblePreset,
  type ProviderId,
  type TestResult,
} from '@comitiva/contract';
import { ProviderIcon } from '../ProviderIcon';
import { ui } from '../ui';

export type Async<T> =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; value: T }
  | { state: 'failed'; code: ErrorCode };

/** The side panel both connection forms live in: header, body, Save/Cancel. */
export function FormShell({
  provider,
  preset,
  editing,
  saving,
  onClose,
  onSubmit,
  children,
}: {
  provider: ProviderId;
  preset?: OpenAICompatiblePreset | undefined;
  editing: boolean;
  saving: Async<void>;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const ids = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <form
        data-testid="connection-form"
        aria-labelledby={`${ids}-title`}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        noValidate
      >
        <header className="flex items-center gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <ProviderIcon provider={provider} preset={preset} />
          <h2 id={`${ids}-title`} className="text-base font-semibold">
            {editing ? t('connections.form.editTitle') : t('connections.form.createTitle')}
          </h2>
        </header>

        <div className="flex flex-1 flex-col gap-4 px-5 py-4">
          {children}
          {saving.state === 'failed' && (
            <p data-testid="form-error" role="alert" className={`text-sm ${ui.bad}`}>
              {t(`errors.${saving.code}`)}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <button type="button" data-testid="cancel" className={ui.button} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            data-testid="save"
            className={ui.primary}
            disabled={saving.state === 'busy'}
          >
            {saving.state === 'busy' ? t('common.saving') : t('common.save')}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Every provider the app can create, API services first, then CLI harnesses. */
export function ProviderSelect({
  value,
  disabled,
  onChange,
}: {
  value: ProviderId;
  disabled: boolean;
  onChange: (provider: ProviderId) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className={ui.label}>
      {t('connections.form.provider')}
      <select
        data-testid="provider"
        className={ui.input}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ProviderId)}
      >
        <optgroup label={t('connections.form.apiGroup')}>
          {apiProviderIds.map((id) => (
            <option key={id} value={id}>
              {providerDescriptors[id].label}
            </option>
          ))}
        </optgroup>
        <optgroup label={t('connections.form.cliGroup')}>
          {cliProviderIds.map((id) => (
            <option key={id} value={id}>
              {cliProviderDescriptors[id].label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

export function TestOutcome({
  test,
  failureHint,
}: {
  test: Async<TestResult>;
  /** Extra line under a failure (e.g. the login command for not_logged_in). */
  failureHint?: (code: ErrorCode) => string | null;
}) {
  const { t } = useTranslation();
  if (test.state === 'idle' || test.state === 'busy')
    return <span data-testid="form-test-result" />;
  const ok = test.state === 'done' && test.value.ok;
  const code: ErrorCode | null =
    test.state === 'done' ? (test.value.ok ? null : test.value.error.code) : test.code;
  const text =
    code === null && test.state === 'done' && test.value.ok
      ? t('connections.testOk', { ms: Math.round(test.value.latencyMs) })
      : t(`errors.${code}`);
  const hint = code !== null ? failureHint?.(code) : null;
  return (
    <span
      data-testid="form-test-result"
      data-ok={ok}
      data-code={code ?? ''}
      role="status"
      className={`flex flex-col text-sm ${ok ? ui.ok : ui.bad}`}
    >
      <span>{text}</span>
      {hint && (
        <span data-testid="form-test-hint" className={ui.hint}>
          {hint}
        </span>
      )}
    </span>
  );
}
