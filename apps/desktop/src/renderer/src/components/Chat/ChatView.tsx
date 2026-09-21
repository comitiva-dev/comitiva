import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@comitiva/contract';
import { connectionState } from '../../lib/agentForm';
import { newDraftKey } from '../../lib/chat';
import { providerLabel } from '../../lib/connectionForm';
import { useConnections, useConversations, useMessages, useStoreApis } from '../../store/context';
import { isRunning } from '../../store/conversations';
import { AgentAvatar } from '../AgentAvatar';
import { Composer } from '../Composer/Composer';
import { ui } from '../ui';
import { MessageList } from './MessageList';
import { StatusDot } from './StatusDot';

/**
 * The open chat: header, messages and composer. With no conversation open
 * (a new one), the first send creates the conversation, then sends into it.
 */
export function ChatView({
  agent,
  conversationId,
}: {
  agent: Agent;
  conversationId: string | null;
}) {
  const { t } = useTranslation();
  const stores = useStoreApis();
  const conversation = useConversations((s) =>
    conversationId ? s.byId[conversationId] : undefined,
  );
  const running = useConversations((s) => (conversationId ? isRunning(s, conversationId) : false));
  const setVisible = useConversations((s) => s.setVisible);
  const draftKey = conversationId ?? newDraftKey(agent.id);
  const draft = useMessages((s) => s.drafts[draftKey] ?? '');
  const sending = useMessages((s) => s.sending[draftKey] ?? false);
  const actionError = useMessages((s) => s.actionError[draftKey] ?? null);
  const setDraft = useMessages((s) => s.setDraft);
  const dismissError = useMessages((s) => s.dismissError);
  const connection = useConnections(
    (s) => s.items.find((c) => c.connection.id === agent.connectionId)?.connection,
  );
  const state = connectionState(connection);
  // Creating the conversation for a first send (before the store's `sending` applies).
  const creating = useRef(false);
  const [isCreating, setCreating] = useState(false);

  // What is on screen is read as it arrives (unread counts skip it).
  useEffect(() => {
    setVisible(conversationId);
    return () => setVisible(null);
  }, [conversationId, setVisible]);

  useEffect(() => {
    if (conversationId) void stores.messages.getState().load(conversationId);
  }, [conversationId, stores]);

  const send = async () => {
    const messages = stores.messages.getState();
    if (conversationId) return messages.send(conversationId);
    const text = messages.drafts[draftKey] ?? '';
    if (!text.trim() || creating.current) return;
    creating.current = true;
    setCreating(true);
    try {
      const id = await stores.conversations.getState().create(agent.id);
      if (!id) return;
      messages.setDraft(id, text);
      messages.setDraft(draftKey, '');
      await stores.messages.getState().send(id);
    } finally {
      creating.current = false;
      setCreating(false);
    }
  };

  const title = conversationId
    ? (conversation?.title ?? t('chat.untitled'))
    : t('chat.newConversation');

  return (
    <section
      data-testid="chat"
      data-conversation={conversationId ?? ''}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex items-center gap-3 border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <AgentAvatar avatar={agent.avatar} name={agent.name} />
        <div className="min-w-0 flex-1">
          <h1 data-testid="agent-title" className="truncate text-base font-semibold">
            {agent.name}
          </h1>
          <p className={`flex items-center gap-1.5 truncate text-xs ${ui.muted}`}>
            {conversation && <StatusDot status={conversation.status} />}
            <span data-testid="chat-title" className="truncate">
              {title}
            </span>
            {connection && (
              <span className="truncate">
                · {providerLabel(connection.provider)}
                {agent.model && ` · ${agent.model}`}
              </span>
            )}
          </p>
        </div>
      </header>

      {conversationId ? (
        <MessageList key={conversationId} conversationId={conversationId} agent={agent} />
      ) : (
        <div
          data-testid="new-conversation-pane"
          className="flex flex-1 items-center justify-center"
        >
          <p className={`max-w-sm text-center text-sm ${ui.muted}`}>
            {t('chat.startHint', { name: agent.name })}
          </p>
        </div>
      )}

      <Composer
        value={draft}
        onChange={(text) => setDraft(draftKey, text)}
        onSend={() => void send()}
        onStop={
          conversationId ? () => void stores.messages.getState().cancel(conversationId) : undefined
        }
        running={running}
        sending={sending || isCreating}
        disabledReason={
          state === 'ok'
            ? null
            : t(state === 'disabled' ? 'agents.connectionDisabled' : 'agents.connectionMissing')
        }
        error={actionError}
        onDismissError={() => dismissError(draftKey)}
        placeholder={t('chat.placeholder', { name: agent.name })}
        focusKey={draftKey}
      />
    </section>
  );
}
