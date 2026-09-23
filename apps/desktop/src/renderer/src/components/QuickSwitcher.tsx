import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { moveSelection, switcherItems, type SwitcherItem } from '../lib/quickSwitcher';
import { useAgents, useConversations, useStoreApis, useUi } from '../store/context';
import { AgentAvatar } from './AgentAvatar';
import { ui } from './ui';

const DEBOUNCE_MS = 120;

/**
 * Cmd/Ctrl+K: jump to an agent, a conversation or a message. Agents match by
 * name here; conversation titles and message text are searched by the
 * backend (full-text, SQLite FTS5 on the desktop). Arrows move, Enter opens,
 * Esc closes.
 */
export function QuickSwitcher() {
  const open = useUi((s) => s.quickSwitcherOpen);
  // Mounted on open, so each time starts with an empty query.
  return open ? <SwitcherPanel /> : null;
}

function SwitcherPanel() {
  const { t } = useTranslation();
  const stores = useStoreApis();
  const search = useUi((s) => s.search);
  const agents = useAgents((s) => s.items);
  const byId = useConversations((s) => s.byId);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => void stores.ui.getState().runSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, stores]);

  const recent = useMemo(
    () =>
      Object.values(byId)
        .filter((c) => !c.archived)
        .map((c) => ({
          id: c.id,
          agentId: c.agentId,
          title: c.title,
          lastActivityAt: c.lastActivityAt,
        })),
    [byId],
  );
  const current = search.query === query.trim() ? search.result : null;
  const items = useMemo(
    () => switcherItems(query, agents, recent, current),
    [query, agents, recent, current],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => stores.ui.getState().closeQuickSwitcher();
  const pick = (item: SwitcherItem | undefined) => {
    if (!item) return;
    stores.app.getState().setSection('agents');
    stores.agents.getState().select(item.agentId);
    if (item.kind !== 'agent') {
      stores.conversations.getState().select(item.agentId, item.conversationId);
    }
    if (item.kind === 'message') {
      void stores.messages.getState().jumpTo(item.conversationId, item.seq);
    }
    close();
  };

  const noResults =
    query.trim() !== '' && search.status === 'ready' && current !== null && items.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('switcher.title')}
        data-testid="quick-switcher"
        className={`${ui.card} flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          data-testid="switcher-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={items[selected] ? `switcher-${selected}` : undefined}
          className="w-full border-b border-neutral-200 bg-transparent px-4 py-3 text-base outline-none dark:border-neutral-800"
          placeholder={t('switcher.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((i) => moveSelection(i, e.key === 'ArrowDown' ? 1 : -1, items.length));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(items[selected]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <ul id="switcher-list" ref={listRef} role="listbox" className="flex-1 overflow-y-auto py-1">
          {items.map((item, i) => {
            const agent = agentById.get(item.agentId);
            const active = i === selected;
            return (
              <li
                key={item.key}
                id={`switcher-${i}`}
                data-index={i}
                data-testid="switcher-item"
                data-kind={item.kind}
                role="option"
                aria-selected={active}
                className={`flex cursor-pointer items-start gap-3 px-4 py-2 text-sm ${
                  active ? 'bg-indigo-50 dark:bg-indigo-950/50' : ''
                }`}
                onMouseMove={() => setSelected(i)}
                onClick={() => pick(item)}
              >
                {agent && <AgentAvatar avatar={agent.avatar} name={agent.name} size="sm" />}
                <span className="min-w-0 flex-1">
                  {item.kind === 'agent' ? (
                    <span className="block truncate font-medium">{item.name}</span>
                  ) : (
                    <>
                      <span className="block truncate font-medium">
                        {item.title ?? t('chat.untitled')}
                      </span>
                      {item.kind === 'message' && (
                        <span
                          data-testid="switcher-snippet"
                          className={`line-clamp-2 block text-xs ${ui.muted}`}
                        >
                          {item.role === 'user' ? `${t('chat.you')}: ` : `${agent?.name ?? ''}: `}
                          {item.snippet.map((p, k) =>
                            p.match ? (
                              <mark
                                key={k}
                                className="rounded-sm bg-amber-200 text-inherit dark:bg-amber-700/60"
                              >
                                {p.text}
                              </mark>
                            ) : (
                              <span key={k}>{p.text}</span>
                            ),
                          )}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <span className={`shrink-0 text-xs ${ui.muted}`}>
                  {t(`switcher.kind.${item.kind}`)}
                </span>
              </li>
            );
          })}
          {noResults && (
            <li
              data-testid="switcher-empty"
              className={`px-4 py-6 text-center text-sm ${ui.muted}`}
            >
              {t('switcher.empty')}
            </li>
          )}
          {search.status === 'failed' && search.error && (
            <li className={`px-4 py-2 text-xs ${ui.bad}`}>{t(`errors.${search.error}`)}</li>
          )}
        </ul>
        <p
          className={`border-t border-neutral-200 px-4 py-2 text-xs dark:border-neutral-800 ${ui.muted}`}
        >
          {t('switcher.keys')}
        </p>
      </div>
    </div>
  );
}
