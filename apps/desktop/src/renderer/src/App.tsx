import { useTranslation } from 'react-i18next';
import { KeyBar } from './components/KeyBar';
import { Pane } from './components/Pane';
import { useSpike } from './store/context';
import { PANES } from './store/spike';

export function App() {
  const { t } = useTranslation();
  const version = useSpike((s) => s.version);
  const runnerStatus = useSpike((s) => s.runnerStatus);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex gap-4 border-b border-gray-400 p-3">
        <h1 className="font-bold">{t('app.title')}</h1>
        <span data-testid="version">{version && t('app.version', { version })}</span>
        <span data-testid="runner-status" data-status={runnerStatus}>
          {t('app.runner', { status: t(`runnerStatus.${runnerStatus}`) })}
        </span>
      </header>
      <KeyBar />
      <main className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
        {PANES.map((id) => (
          <Pane key={id} id={id} />
        ))}
      </main>
    </div>
  );
}
