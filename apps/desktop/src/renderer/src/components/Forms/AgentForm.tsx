import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GOOGLE_DRIVE_TOOL_SERVER_ID, type Agent, type PermissionPolicy } from '@comitiva/contract';
import { errorCode } from '../../backend/Backend';
import {
  addRoot,
  addTags,
  agentFormFor,
  avatarColors,
  avatarEmojis,
  connectionGroups,
  defaultModelOf,
  moveRoot,
  newAgentForm,
  offeredToolServers,
  paramsApply,
  problems,
  removeRoot,
  rootsWithoutFiles,
  setRootMode,
  supportsModelList,
  toggleToolServer,
  toAgentDraft,
  toAgentPatch,
  type AgentFormProblem,
  type AgentFormState,
} from '../../lib/agentForm';
import type { Async } from '../../lib/async';
import { roleTemplateIds, type RoleTemplateId } from '../../lib/roleTemplates';
import { serverDisplayName } from '../../lib/toolServerForm';
import { useAgents, useConnections, useGoogleDrive, useToolServers } from '../../store/context';
import { AgentAvatar, avatarSwatchClasses } from '../AgentAvatar';
import { ui } from '../ui';
import { FormShell } from './FormShell';

const policies: PermissionPolicy[] = ['ask', 'allow-writes', 'read-only'];

/** Create/edit form for an agent: persona, connection, model, folders, tools and permissions. */
export function AgentForm({
  editing,
  prefill,
}: {
  editing: Agent | null;
  prefill?: Partial<AgentFormState> | undefined;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const connections = useConnections((s) => s.items);
  const save = useAgents((s) => s.save);
  const close = useAgents((s) => s.closeEditor);
  const fetchModels = useAgents((s) => s.fetchModels);
  const pickFolder = useConnections((s) => s.pickFolder);
  const toolServers = useToolServers((s) => s.items);
  const driveState = useGoogleDrive((s) => s.status?.state ?? null);

  const [form, setForm] = useState<AgentFormState>(() =>
    editing ? agentFormFor(editing) : newAgentForm(connections, prefill),
  );
  const [saving, setSaving] = useState<Async<void>>({ state: 'idle' });
  const [submitted, setSubmitted] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [pendingTemplate, setPendingTemplate] = useState<RoleTemplateId | null>(null);

  const connection = connections.find((c) => c.connection.id === form.connectionId)?.connection;
  const groups = connectionGroups(connections, editing?.connectionId ?? null);
  const listable = supportsModelList(connection);
  const models = useAgents((s) => (listable ? s.models[form.connectionId] : undefined));
  const blocking = problems(form, connections);
  const show = (p: AgentFormProblem) => submitted && blocking.includes(p);
  const modelRequired = connection?.kind === 'api' && !defaultModelOf(connection);

  useEffect(() => {
    if (listable) void fetchModels(form.connectionId);
  }, [listable, form.connectionId, fetchModels]);

  const templateRole = (id: RoleTemplateId) => t(`agents.templates.${id}.role`);
  const isTemplateText = (role: string) =>
    role.trim() === '' || roleTemplateIds.some((id) => templateRole(id) === role);

  function applyTemplate(id: RoleTemplateId) {
    if (isTemplateText(form.role)) {
      setForm({ ...form, role: templateRole(id) });
      setPendingTemplate(null);
    } else {
      setPendingTemplate(id);
    }
  }

  async function submit() {
    setSubmitted(true);
    const withTags = { ...form, tags: addTags(form.tags, tagInput) };
    setForm(withTags);
    setTagInput('');
    if (problems(withTags, connections).length > 0) return;
    setSaving({ state: 'busy' });
    try {
      await save(
        editing
          ? { id: editing.id, patch: toAgentPatch(withTags, editing) }
          : { draft: toAgentDraft(withTags) },
      );
    } catch (err) {
      setSaving({ state: 'failed', code: errorCode(err) });
    }
  }

  const modelPlaceholder =
    connection?.kind === 'cli'
      ? t('agents.form.modelHarnessDefault')
      : defaultModelOf(connection)
        ? t('agents.form.modelConnectionDefault', { model: defaultModelOf(connection) })
        : t('agents.form.modelPlaceholder');

  return (
    <FormShell
      icon={<AgentAvatar avatar={avatarOf(form)} name={form.name} />}
      title={editing ? t('agents.form.editTitle') : t('agents.form.createTitle')}
      testId="agent-form"
      saving={saving}
      onClose={close}
      onSubmit={() => void submit()}
    >
      <label className={ui.label}>
        {t('agents.form.name')}
        <input
          data-testid="agent-name"
          className={ui.input}
          value={form.name}
          aria-invalid={show('name')}
          placeholder={t('agents.form.namePlaceholder')}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        {show('name') && (
          <span className={`text-xs ${ui.bad}`}>{t('agents.form.nameRequired')}</span>
        )}
      </label>

      <fieldset className={ui.label}>
        <legend className="mb-1">{t('agents.form.avatar')}</legend>
        <div className="flex items-center gap-3">
          <AgentAvatar avatar={avatarOf(form)} name={form.name} size="lg" />
          <div
            role="radiogroup"
            aria-label={t('agents.form.color')}
            className="flex flex-wrap gap-1.5"
          >
            {avatarColors.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={form.color === color}
                aria-label={t(`agents.colors.${color}`)}
                data-testid={`avatar-color-${color}`}
                onClick={() => setForm({ ...form, color })}
                className={`h-6 w-6 rounded-full ${avatarSwatchClasses[color]} ${
                  form.color === color
                    ? 'ring-2 ring-neutral-900 ring-offset-2 ring-offset-white dark:ring-neutral-100 dark:ring-offset-neutral-950'
                    : ''
                }`}
              />
            ))}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-9 gap-1" data-testid="emoji-grid">
          <button
            type="button"
            data-testid="avatar-initials"
            aria-pressed={form.emoji === ''}
            title={t('agents.form.noEmoji')}
            onClick={() => setForm({ ...form, emoji: '' })}
            className={`h-8 rounded-md text-xs font-semibold ${
              form.emoji === '' ? 'bg-neutral-200 dark:bg-neutral-800' : ui.ghost
            }`}
          >
            Aa
          </button>
          {avatarEmojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-pressed={form.emoji === emoji}
              data-testid="avatar-emoji"
              data-emoji={emoji}
              onClick={() => setForm({ ...form, emoji })}
              className={`h-8 rounded-md text-lg ${
                form.emoji === emoji
                  ? 'bg-neutral-200 dark:bg-neutral-800'
                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
        <input
          data-testid="avatar-emoji-input"
          className={`${ui.input} mt-2 w-40`}
          value={form.emoji}
          maxLength={16}
          placeholder={t('agents.form.emojiPlaceholder')}
          aria-label={t('agents.form.emojiPlaceholder')}
          onChange={(e) => setForm({ ...form, emoji: e.target.value })}
        />
      </fieldset>

      <label className={ui.label}>
        {t('agents.form.connection')}
        <select
          data-testid="agent-connection"
          className={ui.input}
          value={form.connectionId}
          aria-invalid={show('connection')}
          onChange={(e) => setForm({ ...form, connectionId: e.target.value, model: '' })}
        >
          {!connection && <option value="">{t('agents.form.pickConnection')}</option>}
          {groups.api.length > 0 && (
            <optgroup label={t('connections.form.apiGroup')}>
              {groups.api.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.enabled ? c.name : t('agents.form.disabledConnection', { name: c.name })}
                </option>
              ))}
            </optgroup>
          )}
          {groups.cli.length > 0 && (
            <optgroup label={t('connections.form.cliGroup')}>
              {groups.cli.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.enabled ? c.name : t('agents.form.disabledConnection', { name: c.name })}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {show('connection') && (
          <span className={`text-xs ${ui.bad}`}>{t('agents.form.connectionRequired')}</span>
        )}
        {connection && !connection.enabled && (
          <span className={`text-xs ${ui.bad}`}>{t('agents.connectionDisabled')}</span>
        )}
      </label>

      <div className={ui.label}>
        <label htmlFor={`${ids}-model`}>
          {t('agents.form.model')}{' '}
          {!modelRequired && <span className={ui.hint}>{t('connections.form.optional')}</span>}
        </label>
        <input
          id={`${ids}-model`}
          data-testid="agent-model"
          className={ui.input}
          list={`${ids}-models`}
          value={form.model}
          spellCheck={false}
          aria-invalid={show('model')}
          placeholder={modelPlaceholder}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
        <datalist id={`${ids}-models`} data-testid="agent-model-options">
          {models?.state === 'done' &&
            models.value.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.id}
              </option>
            ))}
        </datalist>
        <span
          data-testid="agent-models-status"
          data-state={listable ? (models?.state ?? 'idle') : 'free'}
          className={ui.hint}
        >
          {!listable && connection?.kind === 'cli' && t('agents.form.modelFreeTextCli')}
          {models?.state === 'busy' && t('connections.form.fetching')}
          {models?.state === 'done' &&
            t('connections.form.modelsFound', { count: models.value.length })}
          {models?.state === 'failed' && (
            <span className="flex items-center gap-2">
              <span className={ui.bad}>{t(`errors.${models.code}`)}</span>
              <button
                type="button"
                data-testid="agent-models-retry"
                className="underline"
                onClick={() => void fetchModels(form.connectionId, { force: true })}
              >
                {t('agents.form.retry')}
              </button>
            </span>
          )}
        </span>
        {show('model') && <span className={`text-xs ${ui.bad}`}>{t('errors.model_required')}</span>}
      </div>

      <div className={ui.label}>
        <label htmlFor={`${ids}-role`}>{t('agents.form.role')}</label>
        <div className="flex flex-wrap items-center gap-1" data-testid="role-templates">
          <span className={ui.hint}>{t('agents.form.startFrom')}</span>
          {roleTemplateIds.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`template-${id}`}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-normal hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              onClick={() => applyTemplate(id)}
            >
              {t(`agents.templates.${id}.name`)}
            </button>
          ))}
        </div>
        {pendingTemplate && (
          <div
            role="alert"
            data-testid="template-confirm"
            className="flex items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-normal text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            <span>
              {t('agents.form.replaceRole', {
                template: t(`agents.templates.${pendingTemplate}.name`),
              })}
            </span>
            <span className="flex gap-1">
              <button
                type="button"
                data-testid="template-replace"
                className={ui.ghost}
                onClick={() => {
                  setForm({ ...form, role: templateRole(pendingTemplate) });
                  setPendingTemplate(null);
                }}
              >
                {t('agents.form.replace')}
              </button>
              <button type="button" className={ui.ghost} onClick={() => setPendingTemplate(null)}>
                {t('agents.form.keep')}
              </button>
            </span>
          </div>
        )}
        <textarea
          id={`${ids}-role`}
          data-testid="agent-role"
          className={`${ui.input} min-h-40 font-normal`}
          value={form.role}
          placeholder={t('agents.form.rolePlaceholder')}
          onChange={(e) => setForm({ ...form, role: e.target.value })}
        />
      </div>

      {paramsApply(connection) ? (
        <div className="grid grid-cols-2 gap-3">
          <label className={ui.label}>
            {t('agents.form.temperature')}
            <input
              data-testid="agent-temperature"
              className={ui.input}
              inputMode="decimal"
              value={form.temperature}
              placeholder={t('agents.form.providerDefault')}
              aria-invalid={show('temperature')}
              onChange={(e) => setForm({ ...form, temperature: e.target.value })}
            />
            {show('temperature') && (
              <span className={`text-xs ${ui.bad}`}>{t('agents.form.temperatureInvalid')}</span>
            )}
          </label>
          <label className={ui.label}>
            {t('agents.form.maxTokens')}
            <input
              data-testid="agent-max-tokens"
              className={ui.input}
              inputMode="numeric"
              value={form.maxTokens}
              placeholder={t('agents.form.providerDefault')}
              aria-invalid={show('maxTokens')}
              onChange={(e) => setForm({ ...form, maxTokens: e.target.value })}
            />
            {show('maxTokens') && (
              <span className={`text-xs ${ui.bad}`}>{t('agents.form.maxTokensInvalid')}</span>
            )}
          </label>
        </div>
      ) : (
        <p data-testid="params-cli-note" className={ui.hint}>
          {t('agents.form.paramsCliNote')}
        </p>
      )}

      <fieldset className="flex flex-col gap-2" data-testid="agent-roots">
        <legend className={ui.label}>{t('agents.form.roots')}</legend>
        <p className={ui.hint}>{t('agents.form.rootsHint')}</p>
        {form.roots.map((root, i) => (
          <div key={root.path} data-testid="agent-root" className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={root.path}>
              {root.path}
            </span>
            <select
              aria-label={t('agents.form.rootMode')}
              data-testid="agent-root-mode"
              className={`${ui.input} w-auto`}
              value={root.mode}
              onChange={(e) =>
                setForm(setRootMode(form, i, e.target.value as 'read' | 'readwrite'))
              }
            >
              <option value="readwrite">{t('agents.form.rootModes.readwrite')}</option>
              <option value="read">{t('agents.form.rootModes.read')}</option>
            </select>
            <button
              type="button"
              className={ui.ghost}
              aria-label={t('agents.form.moveUp')}
              disabled={i === 0}
              onClick={() => setForm(moveRoot(form, i, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className={ui.ghost}
              aria-label={t('agents.form.moveDown')}
              disabled={i === form.roots.length - 1}
              onClick={() => setForm(moveRoot(form, i, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className={ui.ghost}
              aria-label={t('agents.form.removeRoot', { path: root.path })}
              onClick={() => setForm(removeRoot(form, i))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          data-testid="add-root"
          className={`${ui.button} self-start`}
          onClick={() =>
            void pickFolder().then((path) => {
              if (path) setForm((f) => addRoot(f, path));
            })
          }
        >
          {t('agents.form.addRoot')}
        </button>
        {connection?.kind === 'cli' && form.roots.some((r) => r.mode === 'readwrite') && (
          <p className={ui.hint}>{t('agents.form.rootsCliNote')}</p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5" data-testid="agent-tools">
        <legend className={ui.label}>{t('agents.form.tools')}</legend>
        {offeredToolServers(toolServers, form.toolServerIds).map((server) => (
          <label key={server.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="agent-tool"
              data-id={server.id}
              checked={form.toolServerIds.includes(server.id)}
              onChange={(e) => setForm(toggleToolServer(form, server.id, e.target.checked))}
            />
            <span>{serverDisplayName(server, t)}</span>
            {!server.enabled && (
              <span className={`text-xs ${ui.muted}`}>{t('agents.form.toolDisabled')}</span>
            )}
            {server.enabled &&
              server.id === GOOGLE_DRIVE_TOOL_SERVER_ID &&
              driveState !== null &&
              driveState !== 'connected' && (
                <span data-testid="drive-not-connected" className={`text-xs ${ui.bad}`}>
                  {t(
                    driveState === 'reconnect_required'
                      ? 'agents.form.driveReconnect'
                      : 'agents.form.driveNotConnected',
                  )}
                </span>
              )}
          </label>
        ))}
        {rootsWithoutFiles(form) && (
          <p data-testid="roots-without-files" className={`text-xs ${ui.bad}`}>
            {t('agents.form.rootsWithoutFiles')}
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5" data-testid="agent-policy">
        <legend className={ui.label}>{t('agents.form.policy')}</legend>
        {policies.map((policy) => (
          <label key={policy} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${ids}-policy`}
              data-testid={`policy-${policy}`}
              className="mt-1"
              checked={form.permissionPolicy === policy}
              onChange={() => setForm({ ...form, permissionPolicy: policy })}
            />
            <span>
              {t(`agents.form.policies.${policy}.label`)}
              <span className={`block ${ui.hint}`}>{t(`agents.form.policies.${policy}.hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className={ui.label}>
        <label htmlFor={`${ids}-tags`}>
          {t('agents.form.tags')} <span className={ui.hint}>{t('connections.form.optional')}</span>
        </label>
        <div className={`${ui.input} flex flex-wrap items-center gap-1`}>
          {form.tags.map((tag) => (
            <span
              key={tag}
              data-testid="agent-tag"
              className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
            >
              {tag}
              <button
                type="button"
                aria-label={t('agents.form.removeTag', { tag })}
                onClick={() => setForm({ ...form, tags: form.tags.filter((x) => x !== tag) })}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            id={`${ids}-tags`}
            data-testid="agent-tags-input"
            className="min-w-24 flex-1 bg-transparent outline-none"
            value={tagInput}
            placeholder={form.tags.length === 0 ? t('agents.form.tagsPlaceholder') : ''}
            onChange={(e) => {
              const text = e.target.value;
              if (text.includes(',')) {
                setForm({ ...form, tags: addTags(form.tags, text) });
                setTagInput('');
              } else {
                setTagInput(text);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setForm({ ...form, tags: addTags(form.tags, tagInput) });
                setTagInput('');
              } else if (e.key === 'Backspace' && tagInput === '' && form.tags.length > 0) {
                setForm({ ...form, tags: form.tags.slice(0, -1) });
              }
            }}
          />
        </div>
      </div>
    </FormShell>
  );
}

const avatarOf = (form: AgentFormState) =>
  form.emoji.trim() ? { color: form.color, emoji: form.emoji.trim() } : { color: form.color };
