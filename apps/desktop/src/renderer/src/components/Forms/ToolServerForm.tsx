import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolDef, ToolServer } from '@comitiva/contract';
import { errorCode } from '../../backend/Backend';
import {
  emptyForm,
  emptyRow,
  formFromServer,
  formProblems,
  formToDraft,
  formToPatch,
  formToSpec,
  type ToolServerForm as Form,
  type ValueRow,
} from '../../lib/toolServerForm';
import { useApp, useToolServers } from '../../store/context';
import { ToolTestResult } from '../ToolList';
import { ui } from '../ui';
import { FormShell, type Async } from './FormShell';

/**
 * Adds or edits a third-party MCP server: a command (stdio) or a URL (http).
 * Env vars and headers can be secrets: they go to the OS keyring, never to
 * the database, and a stored one is never shown again (leave it blank to keep
 * it, type to replace it).
 */
export function ToolServerForm({ editing }: { editing: ToolServer | null }) {
  const { t } = useTranslation();
  const save = useToolServers((s) => s.save);
  const close = useToolServers((s) => s.closeEditor);
  const probe = useToolServers((s) => s.probe);
  const [test, setTest] = useState<Async<ToolDef[]>>({ state: 'idle' });
  const secretStatus = useApp((s) => s.secretStatus);
  const [form, setForm] = useState<Form>(() => (editing ? formFromServer(editing) : emptyForm()));
  const [saving, setSaving] = useState<Async<void>>({ state: 'idle' });
  const [touched, setTouched] = useState(false);
  const problems = formProblems(form);
  const patch = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    // A result for other settings would mislead.
    setTest({ state: 'idle' });
  };
  const rowsKey = form.transport === 'stdio' ? 'env' : 'headers';
  const usesSecrets = form[rowsKey].some((r) => r.secret && r.value !== '');

  const submit = async () => {
    setTouched(true);
    if (problems.length > 0) return;
    setSaving({ state: 'busy' });
    try {
      await save(
        editing ? { id: editing.id, patch: formToPatch(form) } : { draft: formToDraft(form) },
      );
    } catch (err) {
      setSaving({ state: 'failed', code: errorCode(err) });
    }
  };

  /** Starts the unsaved settings in the runner and lists the tools, without saving. */
  const runTest = async () => {
    setTouched(true);
    if (problems.length > 0) return;
    setTest({ state: 'busy' });
    try {
      const spec = formToSpec(form);
      setTest({ state: 'done', value: await probe(editing ? { spec, id: editing.id } : { spec }) });
    } catch (err) {
      setTest({ state: 'failed', code: errorCode(err) });
    }
  };

  const show = (p: (typeof problems)[number]) =>
    touched && problems.includes(p) ? (
      <span data-testid={`problem-${p}`} className={`text-xs ${ui.bad}`}>
        {t(`tools.form.problems.${p}`)}
      </span>
    ) : null;

  return (
    <FormShell
      icon={<span aria-hidden>🧰</span>}
      title={editing ? t('tools.form.editTitle') : t('tools.form.createTitle')}
      testId="tool-server-form"
      saving={saving}
      onClose={close}
      onSubmit={() => void submit()}
    >
      <label className={ui.label}>
        {t('tools.form.name')}
        <input
          data-testid="tool-name-input"
          className={ui.input}
          value={form.name}
          placeholder={t('tools.form.namePlaceholder')}
          onChange={(e) => patch({ name: e.target.value })}
        />
        {show('nameRequired')}
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className={ui.label}>{t('tools.form.transport')}</legend>
        <div className="flex gap-4 text-sm">
          {(['stdio', 'http'] as const).map((transport) => (
            <label key={transport} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="transport"
                data-testid={`transport-${transport}`}
                checked={form.transport === transport}
                onChange={() => patch({ transport })}
              />
              {t(`tools.transport.${transport}`)}
            </label>
          ))}
        </div>
        <p className={ui.hint}>{t(`tools.form.transportHint.${form.transport}`)}</p>
      </fieldset>

      {form.transport === 'stdio' ? (
        <>
          <label className={ui.label}>
            {t('tools.form.command')}
            <input
              data-testid="command"
              className={`${ui.input} font-mono`}
              value={form.command}
              placeholder="npx"
              onChange={(e) => patch({ command: e.target.value })}
            />
            {show('commandRequired')}
          </label>
          <label className={ui.label}>
            {t('tools.form.args')}
            <textarea
              data-testid="args"
              rows={3}
              className={`${ui.input} font-mono`}
              value={form.args}
              placeholder={'-y\n@modelcontextprotocol/server-everything'}
              onChange={(e) => patch({ args: e.target.value })}
            />
            <span className={ui.hint}>{t('tools.form.argsHint')}</span>
          </label>
        </>
      ) : (
        <label className={ui.label}>
          {t('tools.form.url')}
          <input
            data-testid="url"
            className={`${ui.input} font-mono`}
            value={form.url}
            placeholder="https://example.com/mcp"
            onChange={(e) => patch({ url: e.target.value })}
          />
          {show('urlInvalid')}
        </label>
      )}

      <ValueRows
        title={t(form.transport === 'stdio' ? 'tools.form.env' : 'tools.form.headers')}
        keyPlaceholder={form.transport === 'stdio' ? 'API_KEY' : 'Authorization'}
        rows={form[rowsKey]}
        onChange={(rows) => patch({ [rowsKey]: rows })}
      />
      {show('keyInvalid')}
      {show('keyRepeated')}
      {show('secretRequired')}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          data-testid="form-test"
          className={`${ui.button} self-start`}
          disabled={test.state === 'busy'}
          onClick={() => void runTest()}
        >
          {t('tools.form.test')}
        </button>
        <span className={ui.hint}>{t('tools.form.testHint')}</span>
        <ToolTestResult test={test} />
      </div>
      {usesSecrets && secretStatus && !secretStatus.available && (
        <p role="alert" className={`text-xs ${ui.bad}`}>
          {t('secrets.unavailableTitle')}
        </p>
      )}
    </FormShell>
  );
}

function ValueRows({
  title,
  keyPlaceholder,
  rows,
  onChange,
}: {
  title: string;
  keyPlaceholder: string;
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, p: Partial<ValueRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <fieldset className="flex flex-col gap-2" data-testid="value-rows">
      <legend className={ui.label}>{title}</legend>
      {rows.map((row, i) => (
        <div key={i} data-testid="value-row" className="flex items-center gap-2">
          <input
            aria-label={t('tools.form.key')}
            data-testid="row-key"
            className={`${ui.input} w-36 font-mono`}
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            aria-label={t('tools.form.value')}
            data-testid="row-value"
            type={row.secret ? 'password' : 'text'}
            autoComplete="off"
            className={`${ui.input} min-w-0 flex-1 font-mono`}
            value={row.value}
            placeholder={row.secret && row.stored ? t('tools.form.storedSecret') : ''}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <label className="flex items-center gap-1 text-xs" title={t('tools.form.secretHint')}>
            <input
              type="checkbox"
              data-testid="row-secret"
              checked={row.secret}
              // A stored secret stays a secret: clear the row to drop it.
              disabled={row.stored}
              onChange={(e) => update(i, { secret: e.target.checked })}
            />
            {t('tools.form.secret')}
          </label>
          <button
            type="button"
            className={ui.ghost}
            aria-label={t('tools.form.removeRow')}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid="add-row"
        className={`${ui.ghost} self-start`}
        onClick={() => onChange([...rows, emptyRow()])}
      >
        + {t('tools.form.addRow')}
      </button>
    </fieldset>
  );
}
