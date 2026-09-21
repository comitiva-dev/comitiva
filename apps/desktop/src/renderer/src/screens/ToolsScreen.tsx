import { useTranslation } from 'react-i18next';
import type { ToolServer } from '@comitiva/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ToolServerForm } from '../components/Forms/ToolServerForm';
import { Switch } from '../components/Switch';
import { ui } from '../components/ui';
import { describeServer, serverDisplayName } from '../lib/toolServerForm';
import { useAgents, useToolServers } from '../store/context';

/** MCP servers: the built-in Files server and the ones the user adds. */
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
      {test && test.state !== 'idle' && (
        <div data-testid="test-result" data-state={test.state} className="mt-2 text-xs">
          {test.state === 'busy' ? (
            <span className={ui.muted}>{t('tools.testing')}</span>
          ) : test.state === 'failed' ? (
            <span className={ui.bad}>{t(`errors.${test.code}`)}</span>
          ) : (
            <>
              <p className={ui.ok}>{t('tools.toolCount', { count: test.value.length })}</p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {test.value.map((tool) => (
                  <li
                    key={tool.name}
                    data-testid="tool-name"
                    title={tool.description}
                    className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-800"
                  >
                    {tool.name}
                    {tool.annotations?.readOnlyHint && (
                      <span className={`ml-1 ${ui.muted}`}>{t('tools.readOnly')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}
