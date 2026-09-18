import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  apiProviderIds,
  providerDescriptors,
  type ConnectionSummary,
  type ErrorCode,
  type ModelInfo,
  type OpenAICompatiblePreset,
  type TestResult,
} from '@comitiva/contract';
import { errorCode } from '../../backend/Backend';
import {
  baseUrlMode,
  formFor,
  keyRequirement,
  newForm,
  problems,
  toDraft,
  toPatch,
  toTarget,
  withProvider,
  type FormState,
} from '../../lib/connectionForm';
import { useConnections } from '../../store/context';
import { ProviderIcon } from '../ProviderIcon';
import { ui } from '../ui';

type Async<T> =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; value: T }
  | { state: 'failed'; code: ErrorCode };

/**
 * Create/edit form for API connections, driven by the provider descriptors
 * in @comitiva/contract. The typed key lives only in this component's state
 * and is dropped when the form closes; a stored key is never shown.
 */
export function ConnectionForm({ editing }: { editing: ConnectionSummary | null }) {
  const { t } = useTranslation();
  const ids = useId();
  const save = useConnections((s) => s.save);
  const close = useConnections((s) => s.closeEditor);
  const probe = useConnections((s) => s.probe);
  const listModels = useConnections((s) => s.listModels);

  const [form, setForm] = useState<FormState>(() => (editing ? formFor(editing) : newForm()));
  const [showAdvanced, setShowAdvanced] = useState(() => editing !== null && form.baseUrl !== '');
  const [saving, setSaving] = useState<Async<void>>({ state: 'idle' });
  const [test, setTest] = useState<Async<TestResult>>({ state: 'idle' });
  const [models, setModels] = useState<Async<ModelInfo[]>>({ state: 'idle' });
  const [submitted, setSubmitted] = useState(false);

  const editingId = editing?.connection.id ?? null;
  const hasStoredKey = editing?.hasSecret ?? false;
  const requirement = keyRequirement(form);
  const blocking = problems(form, hasStoredKey);
  const target = toTarget(form, editingId);
  const descriptor = providerDescriptors[form.provider];
  const presets =
    form.provider === 'openai-compatible' ? providerDescriptors[form.provider].presets : undefined;

  // Results no longer apply once the settings they were fetched with change.
  const update = (next: FormState) => {
    setForm(next);
    setTest({ state: 'idle' });
    if (
      next.provider !== form.provider ||
      next.preset !== form.preset ||
      next.baseUrl !== form.baseUrl
    ) {
      setModels({ state: 'idle' });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  async function runTest() {
    if (!target) return;
    setTest({ state: 'busy' });
    try {
      setTest({ state: 'done', value: await probe(target) });
    } catch (err) {
      setTest({ state: 'failed', code: errorCode(err) });
    }
  }

  async function fetchModels() {
    if (!target) return;
    setModels({ state: 'busy' });
    try {
      const list = await listModels(target);
      setModels({ state: 'done', value: list });
      if (form.defaultModel === '' && list[0])
        setForm((f) => ({ ...f, defaultModel: list[0]!.id }));
    } catch (err) {
      setModels({ state: 'failed', code: errorCode(err) });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (blocking.length > 0) return;
    setSaving({ state: 'busy' });
    try {
      await save(
        editingId
          ? { id: editingId, patch: toPatch(form, hasStoredKey) }
          : { draft: toDraft(form) },
      );
      // The store closes the form on success; the typed key goes away with it.
    } catch (err) {
      setSaving({ state: 'failed', code: errorCode(err) });
    }
  }

  const show = (problem: 'name' | 'baseUrl' | 'apiKey') => submitted && blocking.includes(problem);
  const showBaseUrl = baseUrlMode(form) === 'required' || showAdvanced;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={close}>
      <form
        data-testid="connection-form"
        aria-labelledby={`${ids}-title`}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <header className="flex items-center gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <ProviderIcon provider={form.provider} preset={form.preset} />
          <h2 id={`${ids}-title`} className="text-base font-semibold">
            {editing ? t('connections.form.editTitle') : t('connections.form.createTitle')}
          </h2>
        </header>

        <div className="flex flex-1 flex-col gap-4 px-5 py-4">
          <label className={ui.label}>
            {t('connections.form.provider')}
            <select
              data-testid="provider"
              className={ui.input}
              value={form.provider}
              disabled={editing !== null}
              onChange={(e) => update(withProvider(form, e.target.value as typeof form.provider))}
            >
              {apiProviderIds.map((id) => (
                <option key={id} value={id}>
                  {providerDescriptors[id].label}
                </option>
              ))}
            </select>
          </label>

          {presets && (
            <label className={ui.label}>
              {t('connections.form.preset')}
              <select
                data-testid="preset"
                className={ui.input}
                value={form.preset}
                onChange={(e) =>
                  update(
                    withProvider(form, form.provider, e.target.value as OpenAICompatiblePreset),
                  )
                }
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === 'custom' ? t('connections.form.customPreset') : p.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className={ui.label}>
            {t('connections.form.name')}
            <input
              data-testid="name"
              className={ui.input}
              value={form.name}
              aria-invalid={show('name')}
              onChange={(e) => update({ ...form, name: e.target.value, nameTouched: true })}
            />
            {show('name') && (
              <span className={`text-xs ${ui.bad}`}>{t('connections.form.nameRequired')}</span>
            )}
          </label>

          {requirement !== 'none' && (
            <div className={ui.label}>
              <label htmlFor={`${ids}-key`}>
                {t('connections.form.apiKey')}{' '}
                {requirement === 'optional' && (
                  <span className={ui.hint}>{t('connections.form.optional')}</span>
                )}
              </label>
              <input
                id={`${ids}-key`}
                data-testid="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className={ui.input}
                value={form.apiKey}
                disabled={form.removeKey}
                aria-invalid={show('apiKey')}
                placeholder={
                  hasStoredKey
                    ? t('connections.form.keySavedPlaceholder')
                    : t('connections.form.keyPlaceholder')
                }
                onChange={(e) => update({ ...form, apiKey: e.target.value })}
              />
              {hasStoredKey && (
                <label className={`flex items-center gap-2 ${ui.hint}`}>
                  <input
                    type="checkbox"
                    data-testid="remove-key"
                    checked={form.removeKey}
                    onChange={(e) => update({ ...form, removeKey: e.target.checked, apiKey: '' })}
                  />
                  {t('connections.form.removeKey')}
                </label>
              )}
              {show('apiKey') && (
                <span className={`text-xs ${ui.bad}`}>{t('connections.form.keyRequired')}</span>
              )}
            </div>
          )}

          {showBaseUrl ? (
            <label className={ui.label}>
              {t('connections.form.baseUrl')}
              <input
                data-testid="base-url"
                className={ui.input}
                value={form.baseUrl}
                spellCheck={false}
                placeholder={descriptor.baseUrl.default}
                aria-invalid={show('baseUrl')}
                onChange={(e) => update({ ...form, baseUrl: e.target.value })}
              />
              {baseUrlMode(form) === 'advanced' && (
                <span className={ui.hint}>{t('connections.form.baseUrlAdvancedHint')}</span>
              )}
              {show('baseUrl') && (
                <span className={`text-xs ${ui.bad}`}>{t('connections.form.baseUrlInvalid')}</span>
              )}
            </label>
          ) : (
            <button
              type="button"
              data-testid="show-advanced"
              className={`${ui.ghost} self-start`}
              onClick={() => setShowAdvanced(true)}
            >
              {t('connections.form.advanced')}
            </button>
          )}

          <div className={ui.label}>
            <label htmlFor={`${ids}-model`}>{t('connections.form.defaultModel')}</label>
            <div className="flex gap-2">
              <input
                id={`${ids}-model`}
                data-testid="default-model"
                className={ui.input}
                list={`${ids}-models`}
                value={form.defaultModel}
                spellCheck={false}
                placeholder={t('connections.form.modelPlaceholder')}
                onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
              />
              <button
                type="button"
                data-testid="fetch-models"
                className={`${ui.button} shrink-0`}
                disabled={!target || models.state === 'busy'}
                onClick={() => void fetchModels()}
              >
                {models.state === 'busy'
                  ? t('connections.form.fetching')
                  : t('connections.form.fetchModels')}
              </button>
            </div>
            <datalist id={`${ids}-models`} data-testid="model-options">
              {models.state === 'done' &&
                models.value.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? m.id}
                  </option>
                ))}
            </datalist>
            <span data-testid="models-status" data-state={models.state} className={ui.hint}>
              {models.state === 'done' &&
                t('connections.form.modelsFound', { count: models.value.length })}
              {models.state === 'failed' && (
                <span className={ui.bad}>{t(`errors.${models.code}`)}</span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="form-test"
              className={ui.button}
              disabled={!target || test.state === 'busy'}
              onClick={() => void runTest()}
            >
              {test.state === 'busy' ? t('connections.testing') : t('connections.test')}
            </button>
            <TestOutcome test={test} />
          </div>

          {saving.state === 'failed' && (
            <p data-testid="form-error" role="alert" className={`text-sm ${ui.bad}`}>
              {t(`errors.${saving.code}`)}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <button type="button" data-testid="cancel" className={ui.button} onClick={close}>
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

function TestOutcome({ test }: { test: Async<TestResult> }) {
  const { t } = useTranslation();
  if (test.state === 'idle' || test.state === 'busy')
    return <span data-testid="form-test-result" />;
  const ok = test.state === 'done' && test.value.ok;
  const text =
    test.state === 'done'
      ? test.value.ok
        ? t('connections.testOk', { ms: Math.round(test.value.latencyMs) })
        : t(`errors.${test.value.error.code}`)
      : t(`errors.${test.code}`);
  return (
    <span
      data-testid="form-test-result"
      data-ok={ok}
      role="status"
      className={`text-sm ${ok ? ui.ok : ui.bad}`}
    >
      {text}
    </span>
  );
}
