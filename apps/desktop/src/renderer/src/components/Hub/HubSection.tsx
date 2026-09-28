import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../store/context';
import { ui } from '../ui';

/**
 * Settings → Hub: the hub's address, and signing in to it or creating an
 * account. The token stays in the main process; this form never sees it.
 */
export function HubSection() {
  const { t } = useTranslation();
  const status = useHub((s) => s.status);
  const busy = useHub((s) => s.busy);
  const notice = useHub((s) => s.notice);
  const configure = useHub((s) => s.configure);
  const login = useHub((s) => s.login);
  const register = useHub((s) => s.register);
  const logout = useHub((s) => s.logout);
  const [url, setUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const shownUrl = url ?? status?.url ?? '';
  const user = status?.user ?? null;

  return (
    <section
      data-testid="hub-section"
      className={`${ui.card} flex flex-col gap-3 p-4`}
      aria-labelledby="settings-hub"
    >
      <h2 id="settings-hub" className="text-base font-semibold">
        {t('hub.title')}
      </h2>
      <p className={`text-sm ${ui.muted}`}>{t('hub.body')}</p>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void configure(shownUrl.trim() || null).then((ok) => ok && setUrl(null));
        }}
      >
        <label className={`${ui.label} flex-1`}>
          {t('hub.address')}
          <input
            data-testid="hub-url"
            className={ui.input}
            placeholder={t('hub.addressPlaceholder')}
            value={shownUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button
          type="submit"
          data-testid="hub-connect"
          className={ui.button}
          disabled={busy !== null}
        >
          {t('hub.check')}
        </button>
      </form>
      {status?.meta && (
        <p data-testid="hub-meta" className={`text-xs ${ui.ok}`}>
          {t('hub.connected', {
            edition: t(`hub.editions.${status.meta.edition}`),
            version: status.meta.contractVersion,
          })}
        </p>
      )}

      {status?.url && user && (
        <div className="flex items-center justify-between gap-2">
          <p data-testid="hub-user" className="text-sm">
            {t('hub.signedInAs', { name: user.name, email: user.email })}
          </p>
          <button
            data-testid="hub-signout"
            className={ui.button}
            disabled={busy !== null}
            onClick={() => void logout()}
          >
            {t('hub.signOut')}
          </button>
        </div>
      )}

      {status?.url && !user && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void (
              mode === 'signin'
                ? login({ email, password })
                : register({ name: name.trim(), email, password })
            ).then((ok) => ok && setPassword(''));
          }}
        >
          <div className="flex gap-2 text-sm" role="tablist">
            {(['signin', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                data-testid={`hub-mode-${m}`}
                className={mode === m ? ui.button : ui.ghost}
                onClick={() => setMode(m)}
              >
                {t(m === 'signin' ? 'hub.signIn' : 'hub.createAccount')}
              </button>
            ))}
          </div>
          {mode === 'register' && (
            <label className={ui.label}>
              {t('hub.name')}
              <input
                data-testid="hub-name"
                className={ui.input}
                value={name}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label className={ui.label}>
            {t('hub.email')}
            <input
              data-testid="hub-email"
              type="email"
              className={ui.input}
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className={ui.label}>
            {t('hub.password')}
            <input
              data-testid="hub-password"
              type="password"
              className={ui.input}
              value={password}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'register' && <span className={ui.hint}>{t('hub.passwordHint')}</span>}
          </label>
          <div>
            <button
              type="submit"
              data-testid="hub-submit"
              className={ui.primary}
              disabled={
                busy !== null || !email || !password || (mode === 'register' && !name.trim())
              }
            >
              {t(mode === 'signin' ? 'hub.signIn' : 'hub.createAccount')}
            </button>
          </div>
        </form>
      )}

      {notice && (
        <p role="alert" data-testid="hub-notice" className={`text-sm ${ui.bad}`}>
          {t(`errors.${notice}`)}
        </p>
      )}
    </section>
  );
}
