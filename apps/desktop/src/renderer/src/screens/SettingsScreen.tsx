import { useTranslation } from 'react-i18next';
import { ui } from '../components/ui';
import { useTransfer } from '../store/context';

/** Preferences and data: language, updates, export and import, shortcuts. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const busy = useTransfer((s) => s.busy);
  const exportAgents = useTransfer((s) => s.exportAgents);
  const importBundle = useTransfer((s) => s.importBundle);

  return (
    <section
      data-testid="settings-screen"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6"
    >
      <header>
        <h1 className="text-xl font-semibold">{t('nav.settings')}</h1>
      </header>

      <section className={`${ui.card} flex flex-col gap-3 p-4`} aria-labelledby="settings-data">
        <h2 id="settings-data" className="text-base font-semibold">
          {t('settings.data.title')}
        </h2>
        <p className={`text-sm ${ui.muted}`}>{t('settings.data.body')}</p>
        <div className="flex flex-wrap gap-2">
          <button
            data-testid="export-all"
            className={ui.button}
            disabled={busy !== null}
            onClick={() => void exportAgents()}
          >
            {t('settings.data.exportAll')}
          </button>
          <button
            data-testid="import-bundle"
            className={ui.button}
            disabled={busy !== null}
            onClick={() => void importBundle()}
          >
            {t('settings.data.import')}
          </button>
        </div>
      </section>
    </section>
  );
}
