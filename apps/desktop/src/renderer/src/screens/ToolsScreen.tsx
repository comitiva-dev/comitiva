import { useTranslation } from 'react-i18next';
import { GOOGLE_DRIVE_TOOL_SERVER_ID, type ToolServer } from '@comitiva/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { GoogleDriveSetup } from '../components/Forms/GoogleDriveSetup';
import { ToolServerForm } from '../components/Forms/ToolServerForm';
import { Switch } from '../components/Switch';
import { ToolTestResult } from '../components/ToolList';
import { ui } from '../components/ui';
import { describeServer, serverDisplayName } from '../lib/toolServerForm';
import { useAgents, useGoogleDrive, useToolServers } from '../store/context';

/** MCP servers: the built-in Files and Google Drive servers and the ones the user adds. */
export function ToolsScreen() {
  const { t } = useTranslation();
  const items = useToolServers((s) => s.items);
  const editor = useToolServers((s) => s.editor);
  const notice = useToolServers((s) => s.notice);
  const confirmDelete = useToolServers((s) => s.confirmDelete);
  const openCreate = useToolServers((s) => s.openCreate);
  const dismissNotice = useToolServers((s) => s.dismissNotice);
  const cancelDelete = useToolServers((s) => s.cancelDelete);
  const confirmDeletion = useToolServers((s) => s.confirmDeletion);
  const agents = useAgents((s) => s.items);
  const driveSetupOpen = useGoogleDrive((s) => s.setupOpen);
  const confirmDisconnect = useGoogleDrive((s) => s.confirmDisconnect);
  const cancelDisconnect = useGoogleDrive((s) => s.cancelDisconnect);
  const disconnect = useGoogleDrive((s) => s.disconnect);
  const clearTest = useToolServers((s) => s.clearTest);

  const editing = editor.mode === 'edit' ? (items.find((i) => i.id === editor.id) ?? null) : null;
  const deleting = items.find((i) => i.id === confirmDelete);
  const usedBy = deleting ? agents.filter((a) => a.toolServerIds.includes(deleting.id)) : [];

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
      data-testid="tools-screen"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('tools.title')}</h1>
          <p className={`text-sm ${ui.muted}`}>{t('tools.subtitle')}</p>
        </div>
        <button data-testid="add-tool-server" className={ui.primary} onClick={openCreate}>
          {t('tools.add')}
        </button>
      </header>

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

      <ul className={`${ui.card} divide-y divide-neutral-200 dark:divide-neutral-800`}>
        {items.map((server) => (
          <ToolServerRow key={server.id} server={server} />
        ))}
      </ul>

      {editor.mode !== 'closed' && (
        <ToolServerForm key={editor.mode === 'edit' ? editor.id : 'new'} editing={editing} />
      )}

      {driveSetupOpen && <GoogleDriveSetup />}

      {confirmDisconnect && (
        <ConfirmDialog
          title={t('tools.drive.disconnectTitle')}
          body={t('tools.drive.disconnectBody')}
          confirmLabel={t('tools.drive.disconnect')}
          onConfirm={() => {
            clearTest(GOOGLE_DRIVE_TOOL_SERVER_ID);
            void disconnect();
          }}
          onCancel={cancelDisconnect}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('tools.deleteTitle', { name: deleting.name })}
          body={
            usedBy.length > 0
              ? t('tools.deleteBodyUsed', { count: usedBy.length })
              : t('tools.deleteBody')
          }
          confirmLabel={t('tools.delete')}
          onConfirm={() => void confirmDeletion()}
          onCancel={cancelDelete}
        />
      )}
    </section>
  );
}

function ToolServerRow({ server }: { server: ToolServer }) {
  const { t } = useTranslation();
  const test = useToolServers((s) => s.tests[server.id]);
  const runTest = useToolServers((s) => s.test);
  const setEnabled = useToolServers((s) => s.setEnabled);
  const openEdit = useToolServers((s) => s.openEdit);
  const askDelete = useToolServers((s) => s.askDelete);
  const name = serverDisplayName(server, t);

  return (
    <li data-testid="tool-server-row" data-id={server.id} data-name={name} className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className={`flex items-center gap-2 font-medium ${server.enabled ? '' : ui.muted}`}>
            <span className="truncate">{name}</span>
            {server.builtin && (
              <span
                data-testid="builtin-badge"
                className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {t('tools.builtin.badge')}
              </span>
            )}
            <span className={`text-xs font-normal ${ui.muted}`}>
              {t(`tools.transport.${server.transport}`)}
            </span>
          </p>
          <p className={`truncate text-xs ${ui.muted}`}>
            {server.builtin ? t(`tools.builtin.${server.id}.description`) : describeServer(server)}
          </p>
        </div>
        <Switch
          checked={server.enabled}
          label={t('tools.enabled')}
          testId="toggle-enabled"
          onChange={(enabled) => void setEnabled(server.id, enabled)}
        />
        <div className="flex shrink-0 gap-1">
          <button
            data-testid="test"
            className={ui.ghost}
            disabled={test?.state === 'busy'}
            onClick={() => void runTest(server.id)}
          >
            {t('tools.test')}
          </button>
          {!server.builtin && (
            <>
              <button data-testid="edit" className={ui.ghost} onClick={() => openEdit(server.id)}>
                {t('tools.edit')}
              </button>
              <button
                data-testid="delete"
                className={ui.ghost}
                onClick={() => askDelete(server.id)}
              >
                {t('tools.delete')}
              </button>
            </>
          )}
        </div>
      </div>
      {server.id === GOOGLE_DRIVE_TOOL_SERVER_ID && <GoogleDriveAccount />}
      {test && <ToolTestResult test={test} />}
    </li>
  );
}

/** The Drive row's account: set up the OAuth client, connect, reconnect or disconnect. */
function GoogleDriveAccount() {
  const { t } = useTranslation();
  const status = useGoogleDrive((s) => s.status);
  const busy = useGoogleDrive((s) => s.busy);
  const notice = useGoogleDrive((s) => s.notice);
  const openSetup = useGoogleDrive((s) => s.openSetup);
  const connect = useGoogleDrive((s) => s.connect);
  const cancelConnect = useGoogleDrive((s) => s.cancelConnect);
  const askDisconnect = useGoogleDrive((s) => s.askDisconnect);
  const dismissNotice = useGoogleDrive((s) => s.dismissNotice);
  const clearTest = useToolServers((s) => s.clearTest);
  if (!status) return null;

  const state = !status.clientConfigured ? 'unconfigured' : status.state;
  const onConnect = () => {
    clearTest(GOOGLE_DRIVE_TOOL_SERVER_ID);
    void connect();
  };
  const clientButton = (
    <button data-testid="drive-setup" className={ui.ghost} onClick={openSetup}>
      {t(status.clientConfigured ? 'tools.drive.editClient' : 'tools.drive.setUp')}
    </button>
  );

  return (
    <div
      data-testid="drive-account"
      data-state={state}
      className="mt-2 flex flex-col gap-2 rounded-md bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800/50"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p
          data-testid="drive-status"
          className={`min-w-0 flex-1 ${state === 'reconnect_required' ? ui.bad : ''}`}
        >
          {state === 'connected'
            ? t('tools.drive.connectedAs', {
                email: status.email ?? t('tools.drive.unknownAccount'),
              })
            : t(`tools.drive.state.${state}`)}
        </p>
        {state === 'unconfigured' && (
          <button data-testid="drive-setup" className={ui.primary} onClick={openSetup}>
            {t('tools.drive.setUp')}
          </button>
        )}
        {state === 'disconnected' && (
          <>
            {clientButton}
            <button data-testid="drive-connect" className={ui.primary} onClick={onConnect}>
              {t('tools.drive.connect')}
            </button>
          </>
        )}
        {state === 'connecting' && (
          <button
            data-testid="drive-cancel"
            className={ui.button}
            onClick={() => void cancelConnect()}
          >
            {t('common.cancel')}
          </button>
        )}
        {(state === 'connected' || state === 'reconnect_required') && (
          <>
            {clientButton}
            {state === 'reconnect_required' && (
              <button data-testid="drive-connect" className={ui.primary} onClick={onConnect}>
                {t('tools.drive.reconnect')}
              </button>
            )}
            <button
              data-testid="drive-disconnect"
              className={ui.button}
              disabled={busy === 'disconnect'}
              onClick={askDisconnect}
            >
              {t('tools.drive.disconnect')}
            </button>
          </>
        )}
      </div>
      {notice && (
        <p
          role="alert"
          data-testid="drive-notice"
          data-code={notice}
          className={`text-xs ${ui.bad}`}
        >
          {t(`errors.${notice}`)}{' '}
          <button className="underline" onClick={dismissNotice}>
            {t('common.dismiss')}
          </button>
        </p>
      )}
    </div>
  );
}
