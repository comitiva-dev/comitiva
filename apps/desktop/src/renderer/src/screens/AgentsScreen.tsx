import { useTranslation } from 'react-i18next';
import { AgentAvatar } from '../components/AgentAvatar';
import { AgentPanel } from '../components/AgentPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AgentForm } from '../components/Forms/AgentForm';
import { ui } from '../components/ui';
import { providerLabel } from '../lib/connectionForm';
import { sampleTemplate } from '../lib/roleTemplates';
import { useAgents, useApp, useConnections } from '../store/context';

/** Agents: the selected agent (conversations arrive in Phase 4) and its details panel. */
export function AgentsScreen() {
  const { t } = useTranslation();
  const agents = useAgents((s) => s.items);
  const selectedId = useAgents((s) => s.selectedId);
  const editor = useAgents((s) => s.editor);
  const notice = useAgents((s) => s.notice);
  const confirmDelete = useAgents((s) => s.confirmDelete);
  const dismissNotice = useAgents((s) => s.dismissNotice);
  const cancelDelete = useAgents((s) => s.cancelDelete);
  const confirmDeletion = useAgents((s) => s.confirmDeletion);

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const editing = editor.mode === 'edit' ? (agents.find((a) => a.id === editor.id) ?? null) : null;
  const deleting = agents.find((a) => a.id === confirmDelete);

  return (
    <div className="flex min-w-0 flex-1" data-testid="agents-screen">
      <section className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {notice && (
          <div
            role="alert"
            data-testid="agents-notice"
            data-code={notice}
            className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            <span>{t(`errors.${notice}`)}</span>
            <button className={ui.ghost} onClick={dismissNotice} aria-label={t('common.dismiss')}>
              ✕
            </button>
          </div>
        )}
        {selected ? <SelectedAgent /> : <NoSelection />}
      </section>

      {selected && <AgentPanel agent={selected} />}

      {editor.mode !== 'closed' && (
        <AgentForm
          key={editor.mode === 'edit' ? editor.id : 'new'}
          editing={editing}
          prefill={editor.mode === 'create' ? editor.prefill : undefined}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('agents.deleteTitle', { name: deleting.name })}
          body={t('agents.deleteBody')}
          confirmLabel={t('agents.delete')}
          onConfirm={() => void confirmDeletion()}
          onCancel={cancelDelete}
        />
      )}
    </div>
  );
}

function SelectedAgent() {
  const { t } = useTranslation();
  const agent = useAgents((s) => s.items.find((a) => a.id === s.selectedId))!;
  const connection = useConnections(
    (s) => s.items.find((c) => c.connection.id === agent.connectionId)?.connection,
  );
  return (
    <>
      <header className="flex items-center gap-3">
        <AgentAvatar avatar={agent.avatar} name={agent.name} />
        <div className="min-w-0">
          <h1 data-testid="agent-title" className="truncate text-xl font-semibold">
            {agent.name}
          </h1>
          {connection && (
            <p className={`truncate text-sm ${ui.muted}`}>
              {providerLabel(connection.provider)}
              {agent.model && ` · ${agent.model}`}
            </p>
          )}
        </div>
      </header>
      <div className={`${ui.card} p-8 text-center`}>
        <p className={`text-sm ${ui.muted}`}>{t('agents.conversationsSoon')}</p>
      </div>
    </>
  );
}

function NoSelection() {
  const { t } = useTranslation();
  const loaded = useAgents((s) => s.loaded);
  const hasAgents = useAgents((s) => s.items.length > 0);
  const settings = useAgents((s) => s.settings);
  const openCreate = useAgents((s) => s.openCreate);
  const createSample = useAgents((s) => s.createSample);
  const dismissSample = useAgents((s) => s.dismissSample);
  const connectionsLoaded = useConnections((s) => s.loaded);
  const hasConnections = useConnections((s) => s.items.length > 0);
  const firstEnabled = useConnections((s) => s.items.find((c) => c.connection.enabled));
  const setSection = useApp((s) => s.setSection);

  if (!loaded || !connectionsLoaded) return null;

  if (!hasAgents && settings?.sampleAgentOffer === 'pending' && firstEnabled) {
    const connection = firstEnabled.connection;
    return (
      <div data-testid="sample-offer" className={`${ui.card} flex flex-col gap-3 p-6`}>
        <div className="flex items-center gap-3">
          <AgentAvatar avatar={{ color: 'indigo', emoji: '🤖' }} name="" size="lg" />
          <div>
            <p className="font-medium">{t('agents.sample.title')}</p>
            <p className={`text-sm ${ui.muted}`}>
              {t('agents.sample.body', { connection: connection.name })}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            data-testid="sample-create"
            className={ui.primary}
            onClick={() =>
              void createSample({
                name: t('agents.sample.name'),
                avatar: { color: 'indigo', emoji: '🤖' },
                connectionId: connection.id,
                role: t(`agents.templates.${sampleTemplate}.role`),
              })
            }
          >
            {t('agents.sample.create')}
          </button>
          <button
            data-testid="sample-dismiss"
            className={ui.button}
            onClick={() => void dismissSample()}
          >
            {t('agents.sample.dismiss')}
          </button>
        </div>
      </div>
    );
  }

  if (!hasConnections) {
    return (
      <div data-testid="agents-need-connection" className={`${ui.card} p-8 text-center`}>
        <p className="font-medium">{t('agents.emptyTitle')}</p>
        <p className={`mt-1 text-sm ${ui.muted}`}>{t('agents.needConnection')}</p>
        <button className={`${ui.primary} mt-4`} onClick={() => setSection('connections')}>
          {t('agents.addConnectionFirst')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="agents-empty-center" className={`${ui.card} p-8 text-center`}>
      <p className="font-medium">{hasAgents ? t('agents.pickTitle') : t('agents.emptyTitle')}</p>
      <p className={`mt-1 text-sm ${ui.muted}`}>
        {hasAgents ? t('agents.pickBody') : t('agents.emptyBody')}
      </p>
      <button
        data-testid="create-agent"
        className={`${ui.primary} mt-4`}
        onClick={() => openCreate()}
      >
        {t('agents.create')}
      </button>
    </div>
  );
}
