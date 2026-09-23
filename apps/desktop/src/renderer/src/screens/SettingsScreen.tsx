import { useTranslation } from 'react-i18next';
import { ui } from '../components/ui';
import { LanguageSetting } from '@comitiva/contract';
import { useSettings, useTransfer } from '../store/context';

/** Preferences and data: language, updates, export and import, shortcuts. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const busy = useTransfer((s) => s.busy);
  const exportAgents = useTransfer((s) => s.exportAgents);
  const importBundle = useTransfer((s) => s.importBundle);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);

  return (
    <section
      data-testid="settings-screen"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6"
    >
      <header>
        <h1 className="text-xl font-semibold">{t('nav.settings')}</h1>
      </header>

      <section className={`${ui.card} flex flex-col gap-3 p-4`} aria-labelledby="settings-general">
        <h2 id="settings-general" className="text-base font-semibold">
          {t('settings.general.title')}
        </h2>
        <label className={`${ui.label} max-w-xs`}>
          {t('settings.general.language')}
          <select
            data-testid="settings-language"
            className={ui.input}
            value={settings?.language ?? 'system'}
            disabled={!settings}
            onChange={(e) => void update({ language: LanguageSetting.parse(e.target.value) })}
          >
            {LanguageSetting.options.map((l) => (
              <option key={l} value={l}>
                {t(`settings.general.languages.${l}`)}
              </option>
            ))}
          </select>
        </label>
      </section>

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
