import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InvitableRole, WorkspaceRole } from '@comitiva/contract';
import { ui } from '../components/ui';
import { useWorkspace, useWorkspaceStore } from '../store/context';

/** The workspace on screen: its name, members and roles, invitations, leaving. */
export function WorkspaceScreen() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const members = useWorkspaceStore((s) => s.members);
  const invitations = useWorkspaceStore((s) => s.invitations);
  const online = useWorkspaceStore((s) => s.online);
  const created = useWorkspaceStore((s) => s.created);
  const busy = useWorkspaceStore((s) => s.busy);
  const notice = useWorkspaceStore((s) => s.notice);
  const invite = useWorkspaceStore((s) => s.invite);
  const revoke = useWorkspaceStore((s) => s.revoke);
  const setRole = useWorkspaceStore((s) => s.setRole);
  const remove = useWorkspaceStore((s) => s.remove);
  const rename = useWorkspaceStore((s) => s.rename);
  const leave = useWorkspaceStore((s) => s.leave);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const dismissCreated = useWorkspaceStore((s) => s.dismissCreated);
  const [email, setEmail] = useState('');
  const [role, setInviteRole] = useState<InvitableRole>('member');
  const [name, setName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const [copied, setCopied] = useState(false);
  if (!workspace) return null;

  const isOwner = workspace.role === 'owner';
  const isAdmin = isOwner || workspace.role === 'admin';
  const onlineIds = new Set(online.map((m) => m.userId));

  return (
    <section
      data-testid="workspace-screen"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{workspace.name}</h1>
        <p className={`text-sm ${ui.muted}`}>{t('hub.workspace.body')}</p>
      </header>

      {notice && (
        <p role="alert" className={`text-sm ${ui.bad}`}>
          {t(`errors.${notice}`)}
        </p>
      )}

      {isAdmin && (
        <form
          className={`${ui.card} flex items-end gap-2 p-4`}
          onSubmit={(e) => {
            e.preventDefault();
            const next = (name ?? workspace.name).trim();
            if (next && next !== workspace.name)
              void rename(next).then((ok) => ok && setName(null));
          }}
        >
          <label className={`${ui.label} flex-1`}>
            {t('hub.workspaceName')}
            <input
              data-testid="workspace-rename"
              className={ui.input}
              value={name ?? workspace.name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="submit" className={ui.button} disabled={busy}>
            {t('common.save')}
          </button>
        </form>
      )}

      <section className={`${ui.card} flex flex-col gap-2 p-4`} aria-labelledby="ws-members">
        <h2 id="ws-members" className="text-base font-semibold">
          {t('hub.workspace.members')}
        </h2>
        <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
          {members.map((m) => (
            <li
              key={m.user.id}
              data-testid={`member-${m.user.email}`}
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${onlineIds.has(m.user.id) ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-700'}`}
                />
                <span className="truncate">
                  {m.user.name} <span className={ui.muted}>{m.user.email}</span>
                  {m.user.id === workspace.userId && (
                    <span className={ui.muted}> · {t('hub.workspace.you')}</span>
                  )}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {isOwner && m.user.id !== workspace.userId ? (
                  <select
                    aria-label={t('hub.workspace.role')}
                    className={ui.input}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void setRole(m.user.id, e.target.value as WorkspaceRole)}
                  >
                    {(['owner', 'admin', 'member'] as const).map((r) => (
                      <option key={r} value={r}>
                        {t(`hub.roles.${r}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={ui.muted}>{t(`hub.roles.${m.role}`)}</span>
                )}
                {isAdmin && m.user.id !== workspace.userId && (isOwner || m.role === 'member') && (
                  <button
                    className={ui.ghost}
                    disabled={busy}
                    onClick={() => void remove(m.user.id)}
                  >
                    {t('hub.workspace.remove')}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && (
        <section className={`${ui.card} flex flex-col gap-3 p-4`} aria-labelledby="ws-invite">
          <h2 id="ws-invite" className="text-base font-semibold">
            {t('hub.workspace.invite')}
          </h2>
          <p className={`text-sm ${ui.muted}`}>{t('hub.workspace.inviteBody')}</p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) void invite(email.trim(), role).then((ok) => ok && setEmail(''));
            }}
          >
            <label className={`${ui.label} min-w-48 flex-1`}>
              {t('hub.email')}
              <input
                data-testid="invite-email"
                type="email"
                className={ui.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className={ui.label}>
              {t('hub.workspace.role')}
              <select
                data-testid="invite-role"
                className={ui.input}
                value={role}
                onChange={(e) => setInviteRole(e.target.value as InvitableRole)}
              >
                <option value="member">{t('hub.roles.member')}</option>
                <option value="admin">{t('hub.roles.admin')}</option>
              </select>
            </label>
            <button
              type="submit"
              data-testid="invite-submit"
              className={ui.primary}
              disabled={busy || !email.trim()}
            >
              {t('hub.workspace.createLink')}
            </button>
          </form>
          {created && (
            <div className="flex flex-col gap-1 rounded-md bg-indigo-50 p-3 text-sm dark:bg-indigo-950/40">
              <p>{t('hub.workspace.linkReady')}</p>
              <div className="flex gap-2">
                <input
                  data-testid="invite-link"
                  readOnly
                  className={`${ui.input} font-mono text-xs`}
                  value={created.url}
                />
                <button
                  className={ui.button}
                  onClick={() => {
                    void navigator.clipboard.writeText(created.url).then(() => setCopied(true));
                  }}
                >
                  {copied ? t('hub.workspace.copied') : t('hub.workspace.copy')}
                </button>
                <button
                  className={ui.ghost}
                  onClick={() => {
                    setCopied(false);
                    dismissCreated();
                  }}
                >
                  {t('common.dismiss')}
                </button>
              </div>
            </div>
          )}
          {invitations.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2">
                  <span>
                    {i.email} <span className={ui.muted}>· {t(`hub.roles.${i.role}`)}</span>
                  </span>
                  <button className={ui.ghost} disabled={busy} onClick={() => void revoke(i.id)}>
                    {t('hub.workspace.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={`${ui.card} flex flex-wrap items-center gap-2 p-4`}>
        {confirm ? (
          <>
            <p className="flex-1 text-sm">
              {confirm === 'leave'
                ? t('hub.workspace.leaveConfirm')
                : t('hub.workspace.deleteConfirm')}
            </p>
            <button
              data-testid="workspace-confirm"
              className={ui.danger}
              disabled={busy}
              onClick={() => void (confirm === 'leave' ? leave() : deleteWorkspace())}
            >
              {confirm === 'leave' ? t('hub.workspace.leave') : t('hub.workspace.delete')}
            </button>
            <button className={ui.ghost} onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              data-testid="workspace-leave"
              className={ui.button}
              onClick={() => setConfirm('leave')}
            >
              {t('hub.workspace.leave')}
            </button>
            {isOwner && (
              <button
                data-testid="workspace-delete"
                className={ui.button}
                onClick={() => setConfirm('delete')}
              >
                {t('hub.workspace.delete')}
              </button>
            )}
          </>
        )}
      </section>
    </section>
  );
}
