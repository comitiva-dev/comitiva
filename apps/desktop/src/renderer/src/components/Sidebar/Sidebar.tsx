import { useTranslation } from 'react-i18next';
import type { Section } from '../../store/app';
import { useAgents, useApp, useConnections, useUpdates } from '../../store/context';
import { ui } from '../ui';
import { AgentList } from './AgentList';

const settingsSections: Array<Exclude<Section, 'agents'>> = [
  'connections',
  'tools',
  'usage',
  'settings',
];

export function Sidebar() {
  const { t } = useTranslation();
  const section = useApp((s) => s.section);
  const setSection = useApp((s) => s.setSection);
  const version = useApp((s) => s.version);
  const updateReady = useUpdates((s) => (s.status?.state === 'ready' ? s.status.version : null));
  const installUpdate = useUpdates((s) => s.install);
  const runnerStatus = useApp((s) => s.runnerStatus);
  const hasConnections = useConnections((s) => s.items.length > 0);
  const openCreate = useAgents((s) => s.openCreate);
  const select = useAgents((s) => s.select);

  const item = (id: Section, label: string) => (
    <button
      key={id}
      data-testid={`nav-${id}`}
      aria-current={section === id ? 'page' : undefined}
      onClick={() => setSection(id)}
      className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm ${
        section === id
          ? 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
      }`}
    >
      {label}
    </button>
  );

  return (
    <nav
      aria-label={t('nav.label')}
      className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="px-4 py-4 text-lg font-bold tracking-tight">{t('app.title')}</div>

      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1" onClick={() => select(null)}>
            {item('agents', t('nav.agents'))}
          </div>
          {hasConnections && (
            <button
              data-testid="new-agent"
              aria-label={t('agents.create')}
              title={t('agents.create')}
              className={ui.ghost}
              onClick={() => {
                setSection('agents');
                openCreate();
              }}
            >
              +
            </button>
          )}
        </div>
        <AgentList />
      </div>

      <div className="flex flex-col gap-0.5 border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        {settingsSections.map((id) => item(id, t(`nav.${id}`)))}
      </div>

      {updateReady && (
        <button
          data-testid="update-ready"
          className="mx-2 mb-1 rounded-md bg-indigo-600 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-indigo-500"
          onClick={() => void installUpdate()}
        >
          {t('updates.restartTo', { version: updateReady })}
        </button>
      )}
      <footer className={`flex items-center justify-between px-4 py-2 text-xs ${ui.muted}`}>
        <span data-testid="version">{version && t('app.version', { version })}</span>
        <span
          data-testid="runner-status"
          data-status={runnerStatus}
          className="flex items-center gap-1.5"
        >
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${
              runnerStatus === 'ready'
                ? 'bg-emerald-500'
                : runnerStatus === 'stopped'
                  ? 'bg-red-500'
                  : 'bg-amber-500'
            }`}
          />
          {t('app.runner', { status: t(`runnerStatus.${runnerStatus}`) })}
        </span>
      </footer>
    </nav>
  );
}
