import { useTranslation } from 'react-i18next';
import type { Agent } from '@comitiva/contract';
import { connectionState } from '../../lib/agentForm';
import { agentStatus, agentUnread } from '../../store/conversations';
import { useAgents, useApp, useConnections, useConversations } from '../../store/context';
import { AgentAvatar } from '../AgentAvatar';
import { StatusDot } from '../Chat/StatusDot';
import { ui } from '../ui';

/** The sidebar's agents: avatar, name and status; an empty state points to the next step. */
export function AgentList() {
  const { t } = useTranslation();
  const agents = useAgents((s) => s.items);
  const loaded = useAgents((s) => s.loaded);
  const openCreate = useAgents((s) => s.openCreate);
  const hasConnections = useConnections((s) => s.items.length > 0);
  const setSection = useApp((s) => s.setSection);

  if (!loaded) return null;

  if (agents.length === 0) {
    return (
      <div data-testid="agents-empty" className={`px-2.5 py-2 text-xs ${ui.muted}`}>
        <p>{t('sidebar.noAgents')}</p>
        {hasConnections ? (
          <button
            data-testid="sidebar-create-agent"
            className="mt-1 text-indigo-600 hover:underline dark:text-indigo-400"
            onClick={() => {
              setSection('agents');
              openCreate();
            }}
          >
            {t('agents.create')}
          </button>
        ) : (
          <button
            data-testid="sidebar-add-connection"
            className="mt-1 text-indigo-600 hover:underline dark:text-indigo-400"
            onClick={() => setSection('connections')}
          >
            {t('agents.addConnectionFirst')}
          </button>
        )}
      </div>
    );
  }

  return (
    <ul data-testid="agent-list" className="flex flex-col gap-0.5">
      {agents.map((agent) => (
        <AgentItem key={agent.id} agent={agent} />
      ))}
    </ul>
  );
}

function AgentItem({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const selected = useAgents((s) => s.selectedId === agent.id);
  const select = useAgents((s) => s.select);
  const section = useApp((s) => s.section);
  const setSection = useApp((s) => s.setSection);
  const connection = useConnections(
    (s) => s.items.find((c) => c.connection.id === agent.connectionId)?.connection,
  );
  const state = connectionState(connection);
  const active = selected && section === 'agents';
  const status = useConversations((s) => agentStatus(s, agent.id));
  const unread = useConversations((s) => agentUnread(s, agent.id));

  return (
    <li>
      <button
        data-testid="agent-item"
        data-name={agent.name}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          select(agent.id);
          setSection('agents');
        }}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
          active
            ? 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
            : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
        }`}
      >
        <AgentAvatar avatar={agent.avatar} name={agent.name} size="sm" />
        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
        {state !== 'ok' && (
          <span
            data-testid="agent-connection-warning"
            data-state={state}
            title={t(
              state === 'disabled' ? 'agents.connectionDisabled' : 'agents.connectionMissing',
            )}
            className="text-amber-600 dark:text-amber-400"
          >
            ⚠
          </span>
        )}
        {status === 'awaiting-approval' && (
          <span
            data-testid="agent-awaiting"
            title={t('agents.status.awaiting-approval')}
            className="rounded bg-amber-100 px-1 text-xs font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
          >
            {t('sidebar.awaiting')}
          </span>
        )}
        {unread > 0 && (
          <span
            data-testid="agent-unread"
            aria-label={t('sidebar.unread', { count: unread })}
            className="rounded-full bg-indigo-600 px-1.5 text-xs font-medium text-white"
          >
            {unread}
          </span>
        )}
        <StatusDot status={status} testId="agent-status" />
      </button>
    </li>
  );
}
