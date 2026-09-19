import { useTranslation } from 'react-i18next';
import {
  isCliProviderId,
  type ConnectionSummary,
  type OpenAICompatiblePreset,
} from '@comitiva/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConnectionForm } from '../components/Forms/ConnectionForm';
import { ProviderIcon } from '../components/ProviderIcon';
import { ui } from '../components/ui';
import { isApiProvider, providerLabel } from '../lib/connectionForm';
import { relativeTime } from '../lib/time';
import { useApp, useConnections } from '../store/context';

export function ConnectionsScreen() {
  const { t } = useTranslation();
  const items = useConnections((s) => s.items);
  const loaded = useConnections((s) => s.loaded);
  const editor = useConnections((s) => s.editor);
  const notice = useConnections((s) => s.notice);
  const confirmDelete = useConnections((s) => s.confirmDelete);
  const openCreate = useConnections((s) => s.openCreate);
  const dismissNotice = useConnections((s) => s.dismissNotice);
  const cancelDelete = useConnections((s) => s.cancelDelete);
  const confirmDeletion = useConnections((s) => s.confirmDeletion);
  const secretStatus = useApp((s) => s.secretStatus);

  const editing =
    editor.mode === 'edit' ? (items.find((i) => i.connection.id === editor.id) ?? null) : null;
  const deleting = items.find((i) => i.connection.id === confirmDelete);

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
      data-testid="connections-screen"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('connections.title')}</h1>
          <p className={`text-sm ${ui.muted}`}>{t('connections.subtitle')}</p>
        </div>
        <button data-testid="add-connection" className={ui.primary} onClick={openCreate}>
          {t('connections.add')}
        </button>
      </header>

      {secretStatus && !secretStatus.available && (
        <div
          role="alert"
          data-testid="secret-banner"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <p className="font-medium">{t('secrets.unavailableTitle')}</p>
          <p className="mt-1">{t('secrets.unavailableBody')}</p>
        </div>
      )}

      {notice && (
        <div
          role="alert"
          data-testid="notice"
          data-code={notice}
          className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <span>{t(`errors.${notice}`)}</span>
          <button className={ui.ghost} onClick={dismissNotice} aria-label={t('common.dismiss')}>
            ✕
          </button>
        </div>
      )}

      {loaded && items.length === 0 ? (
        <div data-testid="empty" className={`${ui.card} p-8 text-center`}>
          <p className="font-medium">{t('connections.emptyTitle')}</p>
          <p className={`mt-1 text-sm ${ui.muted}`}>{t('connections.emptyBody')}</p>
        </div>
      ) : (
        <ul className={`${ui.card} divide-y divide-neutral-200 dark:divide-neutral-800`}>
          {items.map((item) => (
            <ConnectionRow key={item.connection.id} item={item} />
          ))}
        </ul>
      )}

      {editor.mode !== 'closed' && (
        <ConnectionForm key={editor.mode === 'edit' ? editor.id : 'new'} editing={editing} />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('connections.deleteTitle', { name: deleting.connection.name })}
          body={t('connections.deleteBody')}
          confirmLabel={t('connections.delete')}
          onConfirm={() => void confirmDeletion()}
          onCancel={cancelDelete}
        />
      )}
    </section>
  );
}

function ConnectionRow({ item }: { item: ConnectionSummary }) {
  const { t, i18n } = useTranslation();
  const testing = useConnections((s) => s.testing[item.connection.id] ?? false);
  const test = useConnections((s) => s.test);
  const openEdit = useConnections((s) => s.openEdit);
  const askDelete = useConnections((s) => s.askDelete);
  const setEnabled = useConnections((s) => s.setEnabled);
  const { connection, lastTest } = item;
  if (!isApiProvider(connection.provider) && !isCliProviderId(connection.provider)) return null;

  const config = connection.config as { preset?: OpenAICompatiblePreset; defaultModel?: string };
  const id = connection.id;

  return (
    <li
      data-testid="connection-row"
      data-name={connection.name}
      className="flex items-center gap-3 px-4 py-3"
    >
      <ProviderIcon provider={connection.provider} preset={config.preset} />
      <div className="min-w-0 flex-1">
        <p className={`truncate font-medium ${connection.enabled ? '' : ui.muted}`}>
          {connection.name}
        </p>
        <p className={`truncate text-xs ${ui.muted}`}>
          {providerLabel(connection.provider, config.preset)}
          {config.defaultModel && ` · ${config.defaultModel}`}
        </p>
        <p data-testid="last-test" data-ok={lastTest?.ok ?? ''} className="text-xs">
          {testing ? (
            <span className={ui.muted}>{t('connections.testing')}</span>
          ) : lastTest === null ? (
            <span className={ui.muted}>{t('connections.neverTested')}</span>
          ) : lastTest.ok ? (
            <span className={ui.ok}>
              {t('connections.lastTestOk', {
                ms: lastTest.latencyMs ?? 0,
                when: relativeTime(lastTest.at, i18n.language),
              })}
            </span>
          ) : (
            <span className={ui.bad}>
              {t('connections.lastTestFailed', {
                error: t(`errors.${lastTest.errorCode ?? 'internal'}`),
                when: relativeTime(lastTest.at, i18n.language),
              })}
            </span>
          )}
        </p>
      </div>

      <button
        role="switch"
        aria-checked={connection.enabled}
        aria-label={t('connections.enabled')}
        data-testid="toggle-enabled"
        onClick={() => void setEnabled(id, !connection.enabled)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          connection.enabled ? 'bg-indigo-600' : 'bg-neutral-300 dark:bg-neutral-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            connection.enabled ? 'left-4.5' : 'left-0.5'
          }`}
        />
      </button>

      <div className="flex shrink-0 gap-1">
        <button
          data-testid="test"
          className={ui.ghost}
          disabled={testing}
          onClick={() => void test(id)}
        >
          {t('connections.test')}
        </button>
        <button data-testid="edit" className={ui.ghost} onClick={() => openEdit(id)}>
          {t('connections.edit')}
        </button>
        <button data-testid="delete" className={ui.ghost} onClick={() => askDelete(id)}>
          {t('connections.delete')}
        </button>
      </div>
    </li>
  );
}
