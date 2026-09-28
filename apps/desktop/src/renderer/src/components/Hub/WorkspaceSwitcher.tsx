import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp, useHub } from '../../store/context';
import { ui } from '../ui';

/**
 * Top of the sidebar: which scope the window shows, Personal (this machine)
 * or a hub workspace, plus creating one and joining one by link.
 */
export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const user = useHub((s) => s.status?.user ?? null);
  const workspaces = useHub((s) => s.workspaces);
  const activeId = useHub((s) => s.activeWorkspaceId);
  const busy = useHub((s) => s.busy);
  const notice = useHub((s) => s.notice);
  const switchTo = useHub((s) => s.switchTo);
  const createWorkspace = useHub((s) => s.createWorkspace);
  const join = useHub((s) => s.join);
  const dismissNotice = useHub((s) => s.dismissNotice);
  const setSection = useApp((s) => s.setSection);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'create' | 'join'>('menu');
  const [text, setText] = useState('');

  const active = workspaces.find((w) => w.id === activeId);
  const close = () => {
    setOpen(false);
    setMode('menu');
    setText('');
    dismissNotice();
  };
  const choose = (id: string | null) => {
    close();
    void switchTo(id);
  };

  return (
    <div className="relative px-2 pt-3 pb-1">
      <button
        data-testid="workspace-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="min-w-0">
          <span className="block truncate text-lg font-bold tracking-tight">
            {active ? active.name : t('app.title')}
          </span>
          <span className={`block truncate text-xs ${ui.muted}`} data-testid="workspace-scope">
            {active ? t('hub.workspaceScope') : t('hub.personal')}
          </span>
        </span>
        <span aria-hidden className={ui.muted}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={`${ui.card} absolute top-full right-2 left-2 z-20 mt-1 flex flex-col gap-1 p-2 shadow-lg`}
        >
          <button
            role="menuitem"
            data-testid="workspace-option-personal"
            aria-current={activeId === null}
            className={item(activeId === null)}
            onClick={() => choose(null)}
          >
            {t('hub.personal')}
            <span className={`block text-xs ${ui.muted}`}>{t('hub.personalHint')}</span>
          </button>
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              data-testid={`workspace-option-${w.id}`}
              aria-current={w.id === activeId}
              className={item(w.id === activeId)}
              onClick={() => choose(w.id)}
            >
              {w.name}
              <span className={`block text-xs ${ui.muted}`}>{t(`hub.roles.${w.role}`)}</span>
            </button>
          ))}
          <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
          {!user ? (
            <button
              data-testid="workspace-connect"
              className={item(false)}
              onClick={() => {
                close();
                setSection('settings');
              }}
            >
              {t('hub.connectToHub')}
            </button>
          ) : mode === 'menu' ? (
            <>
              <button
                data-testid="workspace-new"
                className={item(false)}
                onClick={() => setMode('create')}
              >
                {t('hub.newWorkspace')}
              </button>
              <button
                data-testid="workspace-join"
                className={item(false)}
                onClick={() => setMode('join')}
              >
                {t('hub.joinWithLink')}
              </button>
            </>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const value = text.trim();
                if (!value) return;
                void (mode === 'create' ? createWorkspace(value) : join(value)).then((ok) => {
                  if (ok) close();
                });
              }}
            >
              <label className={ui.label}>
                {mode === 'create' ? t('hub.workspaceName') : t('hub.invitationLink')}
                <input
                  autoFocus
                  data-testid={mode === 'create' ? 'workspace-create-name' : 'workspace-join-link'}
                  className={ui.input}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              {notice && (
                <p role="alert" className={`text-xs ${ui.bad}`}>
                  {t(`errors.${notice}`)}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  data-testid={
                    mode === 'create' ? 'workspace-create-submit' : 'workspace-join-submit'
                  }
                  className={ui.primary}
                  disabled={busy !== null || !text.trim()}
                >
                  {mode === 'create' ? t('hub.create') : t('hub.join')}
                </button>
                <button type="button" className={ui.ghost} onClick={() => setMode('menu')}>
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

const item = (current: boolean) =>
  `w-full rounded-md px-2 py-1.5 text-left text-sm ${
    current
      ? 'bg-neutral-200 font-medium dark:bg-neutral-800'
      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
  }`;
