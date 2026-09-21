import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentAvatar } from '../components/AgentAvatar';
import { AgentPanel } from '../components/AgentPanel';
import { ChatView } from '../components/Chat/ChatView';
import { ConversationList } from '../components/Chat/ConversationList';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AgentForm } from '../components/Forms/AgentForm';
import { ui } from '../components/ui';
import { openConversation } from '../lib/chat';
import { sampleTemplate } from '../lib/roleTemplates';
import {
  useAgents,
  useApp,
  useConnections,
  useConversations,
  useStoreApis,
} from '../store/context';
import type { ErrorCode } from '@comitiva/contract';

/** Agents: the selected agent's conversations and chat, and its details panel. */
export function AgentsScreen() {
  const { t } = useTranslation();
  const stores = useStoreApis();
  const agents = useAgents((s) => s.items);
  const selectedId = useAgents((s) => s.selectedId);
  const editor = useAgents((s) => s.editor);
  const notice = useAgents((s) => s.notice);
  const confirmDelete = useAgents((s) => s.confirmDelete);
  const dismissNotice = useAgents((s) => s.dismissNotice);
  const cancelDelete = useAgents((s) => s.cancelDelete);
  const confirmDeletion = useAgents((s) => s.confirmDeletion);
  const chatNotice = useConversations((s) => s.notice);
  const dismissChatNotice = useConversations((s) => s.dismissNotice);
  const loadArchived = useConversations((s) => s.loadArchived);
  const forgetConversations = useConversations((s) => s.forgetAgent);
  const conversationCount = useConversations((s) =>
    confirmDelete
      ? (s.idsByAgent[confirmDelete]?.length ?? 0) +
        (s.archivedIdsByAgent[confirmDelete]?.length ?? 0)
      : 0,
  );

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const editing = editor.mode === 'edit' ? (agents.find((a) => a.id === editor.id) ?? null) : null;
  const deleting = agents.find((a) => a.id === confirmDelete);

  // The delete confirmation counts archived conversations too.
  useEffect(() => {
    if (confirmDelete) void loadArchived(confirmDelete);
  }, [confirmDelete, loadArchived]);

  return (
    <div className="flex min-w-0 flex-1" data-testid="agents-screen">
      <section
        className={`flex min-w-0 flex-1 flex-col ${selected ? '' : 'gap-4 overflow-y-auto p-6'}`}
      >
        {notice && <Notice testId="agents-notice" code={notice} onDismiss={dismissNotice} />}
        {chatNotice && (
          <Notice testId="chat-notice" code={chatNotice} onDismiss={dismissChatNotice} />
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
          body={
            conversationCount > 0
              ? t('agents.deleteBodyConversations', { count: conversationCount })
              : t('agents.deleteBody')
          }
          confirmLabel={t('agents.delete')}
          onConfirm={() => {
            const id = deleting.id;
            void confirmDeletion().then(() => {
              // Gone from the agents store means main deleted it, and its conversations by cascade.
              if (!stores.agents.getState().items.some((a) => a.id === id)) forgetConversations(id);
            });
          }}
          onCancel={cancelDelete}
        />
      )}
    </div>
  );
}

function Notice({
  testId,
  code,
  onDismiss,
}: {
  testId: string;
  code: ErrorCode;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid={testId}
      data-code={code}
      className="m-3 flex items-center justify-between rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <span>{t(`errors.${code}`)}</span>
      <button className={ui.ghost} onClick={onDismiss} aria-label={t('common.dismiss')}>
        ✕
      </button>
    </div>
  );
}

/** The selected agent: its conversations on the left, the open one on the right. */
function SelectedAgent() {
  const agent = useAgents((s) => s.items.find((a) => a.id === s.selectedId))!;
  const openId = useConversations((s) =>
    openConversation(s.selectedByAgent[agent.id], s.idsByAgent[agent.id] ?? []),
  );
  return (
    <div className="flex min-h-0 flex-1">
      <ConversationList agentId={agent.id} openId={openId} />
      <ChatView agent={agent} conversationId={openId} />
    </div>
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
