import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Conversation } from '@comitiva/contract';
import { relativeTime } from '../../lib/time';
import { useConversations } from '../../store/context';
import { ui } from '../ui';
import { StatusDot } from './StatusDot';

const EMPTY: string[] = [];

/** The selected agent's conversations, newest activity first, plus the archived ones on demand. */
export function ConversationList({ agentId, openId }: { agentId: string; openId: string | null }) {
  const { t } = useTranslation();
  const ids = useConversations((s) => s.idsByAgent[agentId] ?? EMPTY);
  const archivedIds = useConversations((s) => s.archivedIdsByAgent[agentId] ?? EMPTY);
  const archivedLoad = useConversations((s) => s.archivedLoad[agentId]);
  const select = useConversations((s) => s.select);
  const loadArchived = useConversations((s) => s.loadArchived);
  const [showArchived, setShowArchived] = useState(false);

  return (
    <nav
      data-testid="conversation-list"
      aria-label={t('chat.conversations')}
      className="flex w-60 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800"
    >
      <div className="p-2">
        <button
          data-testid="new-conversation"
          className={`${ui.button} w-full justify-center`}
          aria-pressed={openId === null}
          onClick={() => select(agentId, null)}
        >
          {t('chat.newConversation')}
        </button>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {ids.map((id) => (
          <ConversationItem key={id} id={id} open={id === openId} />
        ))}
        {ids.length === 0 && (
          <li className={`px-2 py-1 text-xs ${ui.muted}`}>{t('chat.noConversations')}</li>
        )}
        {showArchived && (
          <>
            <li className={`mt-3 px-2 text-xs font-medium uppercase ${ui.muted}`}>
              {t('chat.archived')}
            </li>
            {archivedLoad?.state === 'failed' && (
              <li className={`px-2 text-xs ${ui.bad}`}>{t(`errors.${archivedLoad.code}`)}</li>
            )}
            {archivedIds.map((id) => (
              <ConversationItem key={id} id={id} open={id === openId} />
            ))}
            {archivedLoad?.state === 'done' && archivedIds.length === 0 && (
              <li className={`px-2 py-1 text-xs ${ui.muted}`}>{t('chat.noArchived')}</li>
            )}
          </>
        )}
      </ul>
      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          data-testid="toggle-archived"
          className={`${ui.ghost} w-full justify-center text-xs`}
          onClick={() => {
            if (!showArchived) void loadArchived(agentId);
            setShowArchived((v) => !v);
          }}
        >
          {showArchived ? t('chat.hideArchived') : t('chat.showArchived')}
        </button>
      </div>
    </nav>
  );
}

function ConversationItem({ id, open }: { id: string; open: boolean }) {
  const { t, i18n } = useTranslation();
  const conversation = useConversations((s) => s.byId[id]) as Conversation | undefined;
  const unread = useConversations((s) => s.unread[id] ?? 0);
  const select = useConversations((s) => s.select);
  const rename = useConversations((s) => s.rename);
  const archive = useConversations((s) => s.archive);
  const [editing, setEditingState] = useState<string | null>(null);
  // Enter unmounts the input, which may also fire blur: only the first one saves.
  const editingRef = useRef<string | null>(null);
  const setEditing = (value: string | null) => {
    editingRef.current = value;
    setEditingState(value);
  };

  if (!conversation) return null;
  const title = conversation.title ?? t('chat.untitled');
  const save = () => {
    const next = editingRef.current?.trim();
    if (editingRef.current === null) return;
    setEditing(null);
    if (next && next !== conversation.title) void rename(id, next);
  };

  return (
    <li
      data-testid="conversation-item"
      data-id={id}
      data-title={conversation.title ?? ''}
      data-status={conversation.status}
      data-archived={conversation.archived}
      className={`group flex items-center gap-1 rounded-md ${
        open
          ? 'bg-neutral-200 dark:bg-neutral-800'
          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
      }`}
    >
      {editing !== null ? (
        <input
          data-testid="conversation-rename-input"
          autoFocus
          className={`${ui.input} m-0.5 py-1`}
          value={editing}
          maxLength={200}
          aria-label={t('chat.rename')}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(null);
          }}
        />
      ) : (
        <>
          <button
            aria-current={open ? 'true' : undefined}
            className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
            onClick={() => select(conversation.agentId, id)}
            onDoubleClick={() => setEditing(conversation.title ?? '')}
            title={title}
          >
            <span className="flex items-center gap-1.5">
              <StatusDot status={conversation.status} />
              <span
                data-testid="conversation-title"
                className={`min-w-0 flex-1 truncate text-sm ${unread > 0 ? 'font-semibold' : ''}`}
              >
                {title}
              </span>
              {unread > 0 && (
                <span
                  data-testid="conversation-unread"
                  className="rounded-full bg-indigo-600 px-1.5 text-xs font-medium text-white"
                >
                  {unread}
                </span>
              )}
            </span>
            <span className={`pl-3.5 text-xs ${ui.muted}`}>
              {relativeTime(conversation.lastActivityAt, i18n.language)}
            </span>
          </button>
          <div className="hidden shrink-0 gap-0.5 pr-1 group-focus-within:flex group-hover:flex">
            <button
              data-testid="conversation-rename"
              className={`${ui.ghost} px-1`}
              title={t('chat.rename')}
              aria-label={t('chat.rename')}
              onClick={() => setEditing(conversation.title ?? '')}
            >
              ✎
            </button>
            <button
              data-testid="conversation-archive"
              className={`${ui.ghost} px-1`}
              title={conversation.archived ? t('chat.unarchive') : t('chat.archive')}
              aria-label={conversation.archived ? t('chat.unarchive') : t('chat.archive')}
              onClick={() => void archive(id, !conversation.archived)}
            >
              {conversation.archived ? '↩' : '🗄'}
            </button>
          </div>
        </>
      )}
    </li>
  );
}
