import { useTranslation } from 'react-i18next';
import { relativeTime } from '../lib/time';
import { useSettings, useUpdates } from '../store/context';
import { Switch } from './Switch';
import { ui } from './ui';

/** Settings → Updates: the version, what the updater is doing, and its switch. */
export function UpdatesSection() {
  const { t, i18n } = useTranslation();
  const status = useUpdates((s) => s.status);
  const notice = useUpdates((s) => s.notice);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);

  if (!status) return null;
  const disabled = status.state === 'disabled';
  const busy = status.state === 'checking' || status.state === 'downloading';
  const last = status.lastCheckedAt ? relativeTime(status.lastCheckedAt, i18n.language) : null;

  const line = (() => {
    switch (status.state) {
      case 'disabled':
        return t(`updates.disabled.${status.disabledReason ?? 'unsupported'}`);
      case 'idle':
        return t('updates.idle');
      case 'checking':
        return t('updates.checking');
      case 'not-available':
        return t('updates.upToDate', { when: last ?? '' });
      case 'available':
        return t('updates.available', { version: status.version ?? '' });
      case 'downloading':
        return t('updates.downloading', {
          version: status.version ?? '',
          percent: Math.round(status.percent ?? 0),
        });
      case 'ready':
        return t('updates.ready', { version: status.version ?? '' });
      case 'error':
        return t(`errors.${status.error ?? 'update_failed'}`);
    }
  })();

  return (
    <section className={`${ui.card} flex flex-col gap-3 p-4`} aria-labelledby="settings-updates">
      <h2 id="settings-updates" className="text-base font-semibold">
        {t('updates.title')}
      </h2>
      <p className="text-sm">{t('updates.current', { version: status.currentVersion })}</p>
      <p
        data-testid="update-status"
        data-state={status.state}
        className={`text-sm ${status.state === 'error' ? ui.bad : ui.muted}`}
      >
        {line}
      </p>
      {notice && <p className={`text-sm ${ui.bad}`}>{t(`errors.${notice}`)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {status.state === 'ready' ? (
          <button
            data-testid="update-install"
            className={ui.primary}
            onClick={() => void install()}
          >
            {t('updates.restart')}
          </button>
        ) : status.state === 'available' && status.downloadUrl ? (
          <a
            data-testid="update-download"
            className={ui.primary}
            href={status.downloadUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t('updates.download')}
          </a>
        ) : (
          <button
            data-testid="update-check"
            className={ui.button}
            disabled={disabled || busy}
            onClick={() => void check()}
          >
            {t('updates.check')}
          </button>
        )}
      </div>
      {!disabled && settings && (
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={settings.autoUpdate}
            label={t('updates.auto')}
            testId="update-auto"
            onChange={(on) => void update({ autoUpdate: on })}
          />
          {t('updates.auto')}
        </label>
      )}
    </section>
  );
}
