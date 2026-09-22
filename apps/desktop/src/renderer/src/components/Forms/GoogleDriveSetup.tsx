import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode } from '../../backend/Backend';
import { useApp, useGoogleDrive } from '../../store/context';
import { ui } from '../ui';
import { FormShell, type Async } from './FormShell';

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';
const STEPS = ['project', 'api', 'consent', 'client', 'paste'] as const;

/**
 * The user's own Google OAuth client for the built-in Drive server. Comitiva
 * ships no credentials: each user (or their team) creates a "Desktop app"
 * client. The secret goes to the system keyring and is never shown again.
 */
export function GoogleDriveSetup() {
  const { t } = useTranslation();
  const status = useGoogleDrive((s) => s.status);
  const configure = useGoogleDrive((s) => s.configure);
  const close = useGoogleDrive((s) => s.closeSetup);
  const secretStatus = useApp((s) => s.secretStatus);
  const [clientId, setClientId] = useState(status?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState<Async<void>>({ state: 'idle' });
  const [touched, setTouched] = useState(false);
  const missingId = clientId.trim() === '';
  const changesAccount =
    status?.state !== 'disconnected' && !!status?.clientId && clientId.trim() !== status.clientId;

  const submit = async () => {
    setTouched(true);
    if (missingId) return;
    setSaving({ state: 'busy' });
    try {
      await configure({
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: { value: clientSecret.trim() } } : {}),
      });
    } catch (err) {
      setSaving({ state: 'failed', code: errorCode(err) });
    }
  };

  return (
    <FormShell
      icon={<span aria-hidden>🔑</span>}
      title={t('tools.drive.setup.title')}
      testId="google-drive-setup"
      saving={saving}
      onClose={close}
      onSubmit={() => void submit()}
    >
      <p className="text-sm">{t('tools.drive.setup.intro')}</p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
        {STEPS.map((step) => (
          <li key={step}>{t(`tools.drive.setup.steps.${step}`)}</li>
        ))}
      </ol>
      <a
        href={CONSOLE_URL}
        target="_blank"
        rel="noreferrer"
        className="self-start text-sm text-indigo-600 underline dark:text-indigo-400"
      >
        {t('tools.drive.setup.openConsole')}
      </a>
      <p className={ui.hint}>{t('tools.drive.setup.guide')}</p>

      <label className={ui.label}>
        {t('tools.drive.setup.clientId')}
        <input
          data-testid="drive-client-id"
          className={`${ui.input} font-mono`}
          value={clientId}
          placeholder="123456789-abc.apps.googleusercontent.com"
          autoComplete="off"
          onChange={(e) => setClientId(e.target.value)}
        />
        {touched && missingId && (
          <span data-testid="problem-clientId" className={`text-xs ${ui.bad}`}>
            {t('tools.drive.setup.clientIdRequired')}
          </span>
        )}
      </label>
      <label className={ui.label}>
        {t('tools.drive.setup.clientSecret')}
        <input
          data-testid="drive-client-secret"
          type="password"
          autoComplete="off"
          className={`${ui.input} font-mono`}
          value={clientSecret}
          placeholder={status?.hasClientSecret ? t('tools.form.storedSecret') : ''}
          onChange={(e) => setClientSecret(e.target.value)}
        />
        <span className={ui.hint}>{t('tools.drive.setup.clientSecretHint')}</span>
      </label>
      {changesAccount && (
        <p role="alert" className={`text-xs ${ui.bad}`}>
          {t('tools.drive.setup.changesAccount')}
        </p>
      )}
      {secretStatus && !secretStatus.available && (
        <p role="alert" className={`text-xs ${ui.bad}`}>
          {t('secrets.unavailableTitle')}
        </p>
      )}
    </FormShell>
  );
}
