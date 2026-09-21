import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@comitiva/contract';
import { errorCode } from '../backend/Backend';
import { connectionState, defaultModelOf } from '../lib/agentForm';
import { providerLabel } from '../lib/connectionForm';
import { useAgents, useConnections } from '../store/context';
import { AgentAvatar } from './AgentAvatar';
import { ui } from './ui';

/** Right panel: the selected agent's details, with its role editable in place. */
export function AgentPanel({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const openEdit = useAgents((s) => s.openEdit);
  const duplicate = useAgents((s) => s.duplicate);
  const askDelete = useAgents((s) => s.askDelete);
  const connection = useConnections(
    (s) => s.items.find((c) => c.connection.id === agent.connectionId)?.connection,
  );
  const state = connectionState(connection);
  const fallbackModel =
    connection?.kind === 'cli'
      ? t('agents.panel.harnessDefault')
      : t('agents.panel.connectionDefault', { model: defaultModelOf(connection) ?? '—' });

  return (
    <aside
      data-testid="agent-panel"
      aria-label={t('agents.panel.label')}
      className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-neutral-200 p-4 dark:border-neutral-800"
    >
      <header className="flex items-center gap-3">
        <AgentAvatar avatar={agent.avatar} name={agent.name} size="lg" />
        <div className="min-w-0">
          <h2 data-testid="panel-name" className="truncate text-base font-semibold">
            {agent.name}
          </h2>
          {agent.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {agent.tags.map((tag) => (
                <span
                  key={tag}
                  data-testid="panel-tag"
                  className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="flex gap-1">
        <button data-testid="agent-edit" className={ui.button} onClick={() => openEdit(agent.id)}>
          {t('agents.edit')}
        </button>
        <button
          data-testid="agent-duplicate"
          className={ui.button}
          onClick={() => void duplicate(agent.id, t('agents.copyName', { name: agent.name }))}
        >
          {t('agents.duplicate')}
        </button>
        <button
          data-testid="agent-delete"
          className={ui.button}
          onClick={() => askDelete(agent.id)}
        >
          {t('agents.delete')}
        </button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className={ui.muted}>{t('agents.form.connection')}</dt>
        <dd data-testid="panel-connection" className="min-w-0">
          {connection ? (
            <span className="truncate">
              {connection.name}{' '}
              <span className={ui.muted}>· {providerLabel(connection.provider)}</span>
            </span>
          ) : (
            '—'
          )}
          {state !== 'ok' && (
            <p data-testid="panel-connection-warning" className={`text-xs ${ui.bad}`}>
              {t(state === 'disabled' ? 'agents.connectionDisabled' : 'agents.connectionMissing')}
            </p>
          )}
        </dd>
        <dt className={ui.muted}>{t('agents.form.model')}</dt>
        <dd data-testid="panel-model" className="truncate" title={agent.model ?? fallbackModel}>
          {agent.model ?? <span className={ui.muted}>{fallbackModel}</span>}
        </dd>
        {connection?.kind !== 'cli' && (
          <>
            <dt className={ui.muted}>{t('agents.form.temperature')}</dt>
            <dd data-testid="panel-temperature">
              {agent.params.temperature ?? (
                <span className={ui.muted}>{t('agents.form.providerDefault')}</span>
              )}
            </dd>
            <dt className={ui.muted}>{t('agents.form.maxTokens')}</dt>
            <dd data-testid="panel-max-tokens">
              {agent.params.maxTokens ?? (
                <span className={ui.muted}>{t('agents.form.providerDefault')}</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {/* Keyed by agent: selecting another agent drops an unsaved draft. */}
      <RoleEditor key={agent.id} agent={agent} />
    </aside>
  );
}

/** Click (or Edit) to change the role; Ctrl/Cmd+Enter saves, Esc cancels. */
function RoleEditor({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const updateRole = useAgents((s) => s.updateRole);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const editing = draft !== null;
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  async function save() {
    if (draft === null) return;
    if (draft === agent.role) return setDraft(null);
    setSaving(true);
    try {
      await updateRole(agent.id, draft);
      setDraft(null);
      setError(null);
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('agents.form.role')}</h3>
        {draft === null && (
          <button data-testid="role-edit" className={ui.ghost} onClick={() => setDraft(agent.role)}>
            {t('agents.edit')}
          </button>
        )}
      </div>
      {draft === null ? (
        <button
          data-testid="role-view"
          title={t('agents.panel.clickToEdit')}
          onClick={() => setDraft(agent.role)}
          className="rounded-md p-2 text-left text-sm whitespace-pre-wrap hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
        >
          {agent.role || <span className={ui.muted}>{t('agents.panel.noRole')}</span>}
        </button>
      ) : (
        <>
          <textarea
            ref={ref}
            data-testid="role-input"
            className={`${ui.input} min-h-48`}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setDraft(null);
                setError(null);
              }
            }}
          />
          {error && (
            <p role="alert" data-testid="role-error" className={`text-xs ${ui.bad}`}>
              {t(`errors.${error}`)}
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className={ui.hint}>{t('agents.panel.roleKeys')}</span>
            <span className="flex gap-1">
              <button
                className={ui.button}
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                data-testid="role-save"
                className={ui.primary}
                disabled={saving}
                onClick={() => void save()}
              >
                {t('common.save')}
              </button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
