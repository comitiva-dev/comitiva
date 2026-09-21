import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cliProviderDescriptors,
  isCliProviderId,
  type CliDetectResult,
  type CliProviderDescriptor,
  type CliProviderId,
  type CodexSandbox,
  type ConnectionSummary,
  type ErrorCode,
  type ProviderId,
  type TestResult,
} from '@comitiva/contract';
import { errorCode } from '../../backend/Backend';
import {
  cliFormFor,
  cliProblems,
  codexSandboxes,
  newCliForm,
  toCliDraft,
  toCliPatch,
  toCliTarget,
  withCliProvider,
  type CliFormProblem,
  type CliFormState,
} from '../../lib/cliConnectionForm';
import { useConnections } from '../../store/context';
import { ProviderIcon } from '../ProviderIcon';
import { ui } from '../ui';
import { FormShell, ProviderSelect, TestOutcome, type Async } from './FormShell';

/**
 * Create/edit form for CLI harnesses (Claude Code, Codex). No key: the
 * harness uses its own login. The form says plainly that the harness runs
 * non-interactively and accepts every action on its own.
 */
export function CliConnectionForm({
  editing,
  provider,
  onProvider,
}: {
  editing: ConnectionSummary | null;
  provider: CliProviderId;
  onProvider: (provider: ProviderId) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const save = useConnections((s) => s.save);
  const close = useConnections((s) => s.closeEditor);
  const probe = useConnections((s) => s.probe);
  const detectBinary = useConnections((s) => s.detectBinary);
  const pickFolder = useConnections((s) => s.pickFolder);

  const [form, setForm] = useState<CliFormState>(() =>
    editing ? cliFormFor(editing) : newCliForm(provider),
  );
  const [saving, setSaving] = useState<Async<void>>({ state: 'idle' });
  const [test, setTest] = useState<Async<TestResult>>({ state: 'idle' });
  const [detected, setDetected] = useState<Async<CliDetectResult>>({ state: 'idle' });
  const [submitted, setSubmitted] = useState(false);

  const descriptor: CliProviderDescriptor = cliProviderDescriptors[form.provider];
  const blocking = cliProblems(form);
  const target = toCliTarget(form);
  const editingId = editing?.connection.id ?? null;

  const update = (next: CliFormState) => {
    setForm(next);
    setTest({ state: 'idle' });
    if (next.binaryPath !== form.binaryPath || next.provider !== form.provider) {
      setDetected({ state: 'idle' });
    }
  };

  async function detect() {
    setDetected({ state: 'busy' });
    try {
      const path = form.binaryPath.trim();
      const found = await detectBinary({
        provider: form.provider,
        ...(path !== '' ? { binaryPath: path } : {}),
      });
      setDetected({ state: 'done', value: found });
      setForm((f) => ({ ...f, binaryPath: found.path }));
    } catch (err) {
      setDetected({ state: 'failed', code: errorCode(err) });
    }
  }

  async function chooseFolder() {
    const dir = await pickFolder().catch(() => null);
    if (dir) update({ ...form, workingDirectory: dir });
  }

  async function runTest() {
    if (!target) return;
    setTest({ state: 'busy' });
    try {
      setTest({ state: 'done', value: await probe(target) });
    } catch (err) {
      setTest({ state: 'failed', code: errorCode(err) });
    }
  }

  async function submit() {
    setSubmitted(true);
    if (blocking.length > 0) return;
    setSaving({ state: 'busy' });
    try {
      await save(
        editingId ? { id: editingId, patch: toCliPatch(form) } : { draft: toCliDraft(form) },
      );
    } catch (err) {
      setSaving({ state: 'failed', code: errorCode(err) });
    }
  }

  const show = (p: CliFormProblem) => submitted && blocking.includes(p);
  const failureHint = (code: ErrorCode): string | null => {
    if (code === 'not_logged_in')
      return t('connections.cli.loginHint', { command: descriptor.loginCommand });
    if (code === 'sandbox_unavailable') return t('connections.cli.sandboxHint');
    if (code === 'binary_not_found') return t('connections.cli.binaryHint');
    return null;
  };

  return (
    <FormShell
      icon={<ProviderIcon provider={form.provider} />}
      title={editing ? t('connections.form.editTitle') : t('connections.form.createTitle')}
      saving={saving}
      onClose={close}
      onSubmit={() => void submit()}
    >
      <ProviderSelect
        value={form.provider}
        disabled={editing !== null}
        onChange={(p) => (isCliProviderId(p) ? update(withCliProvider(form, p)) : onProvider(p))}
      />

      <div
        data-testid="auto-accept-notice"
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <p className="font-medium">{t('connections.cli.autoAcceptTitle')}</p>
        <p className="mt-1 text-xs">
          {t('connections.cli.autoAcceptBody', { harness: descriptor.label })}
        </p>
        {descriptor.nativeFileToolsDisableable === 'never' && (
          <p data-testid="native-tools-warning" className="mt-1 text-xs font-medium">
            {t('connections.cli.nativeToolsWarning', { harness: descriptor.label })}
          </p>
        )}
        {descriptor.streaming === 'message' && (
          <p className="mt-1 text-xs">{t('connections.cli.messageStreaming')}</p>
        )}
      </div>

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

      <div className={ui.label}>
        <label htmlFor={`${ids}-bin`}>{t('connections.cli.binaryPath')}</label>
        <div className="flex gap-2">
          <input
            id={`${ids}-bin`}
            data-testid="binary-path"
            className={ui.input}
            value={form.binaryPath}
            spellCheck={false}
            placeholder={t('connections.cli.binaryPlaceholder', { name: descriptor.binaryName })}
            aria-invalid={show('binaryPath')}
            onChange={(e) => update({ ...form, binaryPath: e.target.value })}
          />
          <button
            type="button"
            data-testid="detect-binary"
            className={`${ui.button} shrink-0`}
            disabled={detected.state === 'busy'}
            onClick={() => void detect()}
          >
            {detected.state === 'busy'
              ? t('connections.cli.detecting')
              : t('connections.cli.detect')}
          </button>
        </div>
        <span data-testid="detect-status" data-state={detected.state} className={ui.hint}>
          {detected.state === 'done' &&
            t('connections.cli.detected', { version: detected.value.version })}
          {detected.state === 'failed' && (
            <span className={ui.bad}>{t(`errors.${detected.code}`)}</span>
          )}
          {detected.state === 'idle' && t('connections.cli.binaryHint')}
        </span>
        {show('binaryPath') && (
          <span className={`text-xs ${ui.bad}`}>{t('connections.cli.absolutePath')}</span>
        )}
      </div>

      <div className={ui.label}>
        <label htmlFor={`${ids}-wd`}>{t('connections.cli.workingDirectory')}</label>
        <div className="flex gap-2">
          <input
            id={`${ids}-wd`}
            data-testid="working-directory"
            className={ui.input}
            value={form.workingDirectory}
            spellCheck={false}
            placeholder={t('connections.cli.workingDirectoryPlaceholder')}
            aria-invalid={show('workingDirectory')}
            onChange={(e) => update({ ...form, workingDirectory: e.target.value })}
          />
          <button
            type="button"
            data-testid="choose-folder"
            className={`${ui.button} shrink-0`}
            onClick={() => void chooseFolder()}
          >
            {t('connections.cli.choose')}
          </button>
        </div>
        <span className={ui.hint}>{t('connections.cli.workingDirectoryHint')}</span>
        {show('workingDirectory') && (
          <span className={`text-xs ${ui.bad}`}>{t('connections.cli.absolutePath')}</span>
        )}
      </div>

      {descriptor.sandbox && (
        <label className={ui.label}>
          {t('connections.cli.sandbox')}
          <select
            data-testid="sandbox"
            className={ui.input}
            value={form.sandbox}
            onChange={(e) => update({ ...form, sandbox: e.target.value as CodexSandbox })}
          >
            {codexSandboxes.map((s) => (
              <option key={s} value={s}>
                {t(`connections.cli.sandboxes.${s}`)}
              </option>
            ))}
          </select>
          <span className={ui.hint}>{t(`connections.cli.sandboxHelp.${form.sandbox}`)}</span>
        </label>
      )}

      <label className={ui.label}>
        {t('connections.form.defaultModel')}
        <input
          data-testid="default-model"
          className={ui.input}
          value={form.defaultModel}
          spellCheck={false}
          placeholder={t('connections.cli.modelPlaceholder')}
          onChange={(e) => update({ ...form, defaultModel: e.target.value })}
        />
      </label>

      <label className={ui.label}>
        {t('connections.cli.extraArgs')}
        <textarea
          data-testid="extra-args"
          className={`${ui.input} font-mono`}
          rows={3}
          value={form.extraArgs}
          spellCheck={false}
          onChange={(e) => update({ ...form, extraArgs: e.target.value })}
        />
        <span className={ui.hint}>{t('connections.cli.extraArgsHint')}</span>
      </label>

      <div className="flex items-start gap-3">
        <button
          type="button"
          data-testid="form-test"
          className={`${ui.button} shrink-0`}
          disabled={!target || test.state === 'busy'}
          onClick={() => void runTest()}
        >
          {test.state === 'busy' ? t('connections.testing') : t('connections.test')}
        </button>
        <TestOutcome test={test} failureHint={failureHint} />
      </div>
      {test.state === 'busy' && <p className={ui.hint}>{t('connections.cli.testSlow')}</p>}
    </FormShell>
  );
}
