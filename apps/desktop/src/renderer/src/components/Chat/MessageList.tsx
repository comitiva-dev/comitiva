import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { Agent, ApprovalDecision } from '@comitiva/contract';
import { canRetry, firstItemIndex } from '../../lib/chat';
import { serverDisplayName } from '../../lib/toolServerForm';
import { useConversations, useMessages, useToolServers } from '../../store/context';
import { ui } from '../ui';
import { MessageBubble, type Approval } from './MessageBubble';

/**
 * The open conversation's messages, virtualized (keyed by conversation, so
 * the scroll state starts over on a switch). It sticks to the bottom
 * while the user is there (also while a reply grows), loads older pages when
 * scrolled to the top, and keeps the position when they are prepended.
 */
export function MessageList({
  conversationId,
  agent,
}: {
  conversationId: string;
  agent: Pick<Agent, 'name' | 'avatar'>;
}) {
  const { t } = useTranslation();
  const state = useMessages((s) => s.byConversation[conversationId]);
  const loadOlder = useMessages((s) => s.loadOlder);
  const retry = useMessages((s) => s.retry);
  const load = useMessages((s) => s.load);
  const list = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const [anchorSeq, setAnchorSeq] = useState<number | null>(null);

  const items = state?.items ?? [];
  const ready = state?.status === 'ready';
  // The first message of the first page is where older pages are counted from
  // (set during render, React's pattern for state derived from props).
  if (ready && anchorSeq === null && items[0]) setAnchorSeq(items[0].seq);

  const onRetry = useCallback(() => void retry(conversationId), [retry, conversationId]);

  const pending = useConversations((s) => s.pending[conversationId] ?? null);
  const busy = useConversations((s) => s.deciding[conversationId] ?? false);
  const decide = useConversations((s) => s.decide);
  const toolUseId = pending?.toolUseId;
  const approval = useMemo<Approval | undefined>(
    () =>
      toolUseId === undefined
        ? undefined
        : {
            toolUseId,
            busy,
            onDecide: (d: ApprovalDecision) => void decide(conversationId, toolUseId, d),
          },
    [toolUseId, busy, decide, conversationId],
  );
  const servers = useToolServers((s) => s.items);
  const serverNames = useMemo(
    () => Object.fromEntries(servers.map((s) => [s.id, serverDisplayName(s, t)])),
    [servers, t],
  );
  const retryId = canRetry(items) ? items.at(-1)!.id : null;

  if (!state || (state.status === 'loading' && items.length === 0)) {
    return <div className="flex-1" data-testid="messages-loading" />;
  }
  if (state.status === 'failed') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm">
        <p className={ui.bad}>{t(`errors.${state.error ?? 'internal'}`)}</p>
        <button className={ui.button} onClick={() => void load(conversationId, { force: true })}>
          {t('chat.retry')}
        </button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div data-testid="messages-empty" className="flex flex-1 items-center justify-center">
        <p className={`text-sm ${ui.muted}`}>{t('chat.emptyConversation')}</p>
      </div>
    );
  }

  return (
    <Virtuoso
      ref={list}
      data-testid="message-list"
      className="flex-1"
      data={items}
      firstItemIndex={firstItemIndex(items, anchorSeq)}
      initialTopMostItemIndex={items.length - 1}
      computeItemKey={(_, m) => m.id}
      followOutput={(bottom) => (bottom ? 'auto' : false)}
      atBottomStateChange={(bottom) => (atBottom.current = bottom)}
      atBottomThreshold={48}
      // A streaming reply grows without adding items: keep following it.
      totalListHeightChanged={() => {
        if (atBottom.current) list.current?.scrollToIndex({ index: 'LAST', align: 'end' });
      }}
      startReached={() => void loadOlder(conversationId)}
      components={{
        Header: () =>
          state.loadingOlder ? (
            <p className={`py-2 text-center text-xs ${ui.muted}`}>{t('chat.loadingOlder')}</p>
          ) : (
            <div className="h-2" />
          ),
        Footer: () => <div className="h-2" />,
      }}
      itemContent={(_, message) => (
        <MessageBubble
          message={message}
          agent={agent}
          retry={message.id === retryId ? onRetry : undefined}
          approval={message.status === 'streaming' ? approval : undefined}
          serverNames={serverNames}
        />
      )}
    />
  );
}
