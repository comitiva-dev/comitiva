import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent, ApprovalDecision, Message } from '@comitiva/contract';
import { imageSrc, renderParts, toolState } from '../../lib/chat';
import { useMessages } from '../../store/context';
import { ApprovalCard } from '../ApprovalCard/ApprovalCard';
import { AgentAvatar } from '../AgentAvatar';
import { ToolCallBlock } from '../ToolBlock/ToolCallBlock';
import { ui } from '../ui';
import { Markdown } from './Markdown';

const time = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

/**
 * One message, Slack style: avatar, author and time, then the content. The
 * store keeps unchanged messages as the same object, so only the streaming
 * one re-renders.
 */
export interface Approval {
  toolUseId: string;
  busy: boolean;
  onDecide(decision: ApprovalDecision): void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  agent,
  retry,
  approval,
  serverNames,
  highlighted = false,
}: {
  message: Message;
  agent: Pick<Agent, 'name' | 'avatar'>;
  /** Set on the last message when it is a failed reply. */
  retry?: (() => void) | undefined;
  /** Set on the streaming reply while one of its tool calls waits for the user. */
  approval?: Approval | undefined;
  /** Display names of tool servers by id. */
  serverNames: Record<string, string>;
  /** Briefly marked after the quick switcher jumped to it. */
  highlighted?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const parts = useMemo(() => renderParts(message.content), [message.content]);
  const attachmentUrl = useMessages((s) => s.attachmentUrl);
  const mine = message.role === 'user';
  const streaming = message.status === 'streaming';

  return (
    <article
      data-testid="message"
      data-role={message.role}
      data-status={message.status}
      data-highlighted={highlighted || undefined}
      className={`flex gap-3 px-6 py-2 transition-colors duration-700 ${
        highlighted ? 'bg-amber-50 dark:bg-amber-900/30' : ''
      }`}
    >
      <div className="pt-0.5">
        {mine ? (
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-200 text-xs font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
          >
            {t('chat.youInitial')}
          </span>
        ) : (
          <AgentAvatar avatar={agent.avatar} name={agent.name} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <header className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{mine ? t('chat.you') : agent.name}</span>
          <time dateTime={message.createdAt} className={`text-xs ${ui.muted}`}>
            {time(message.createdAt, i18n.language)}
          </time>
        </header>
        <div
          data-testid="message-content"
          className={`flex flex-col gap-2 text-sm ${streaming ? 'streaming-tail' : ''}`}
        >
          {parts.map((part, i) => {
            if (part.kind === 'text')
              return mine ? (
                <p key={i} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              ) : (
                <Markdown key={i} text={part.text} />
              );
            if (part.kind === 'image')
              return (
                <img
                  key={i}
                  data-testid="message-image"
                  src={imageSrc(part.block, attachmentUrl)}
                  alt={part.block.name ?? ''}
                  title={part.block.name}
                  className="max-h-80 max-w-full self-start rounded-md"
                />
              );
            if (part.kind === 'document')
              return (
                <p
                  key={i}
                  data-testid="message-document"
                  className="flex items-center gap-2 self-start rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <span aria-hidden>📄</span>
                  <span className="font-medium">{part.block.name}</span>
                </p>
              );
            {
              const awaiting = approval?.toolUseId === part.use.id;
              const serverName = part.use.toolServerId.startsWith('harness:')
                ? null
                : (serverNames[part.use.toolServerId] ?? part.use.toolServerId);
              return (
                <div key={i} className="flex flex-col gap-2">
                  <ToolCallBlock
                    use={part.use}
                    result={part.result}
                    state={toolState(part.result, { streaming, awaiting })}
                    serverName={serverName}
                  />
                  {awaiting && (
                    <ApprovalCard
                      use={part.use}
                      serverName={serverName ?? ''}
                      agentName={agent.name}
                      busy={approval.busy}
                      onDecide={approval.onDecide}
                    />
                  )}
                </div>
              );
            }
          })}
          {streaming && (
            // After text, the cursor is drawn at its end by CSS (.streaming-tail); otherwise here.
            <span
              data-testid="streaming"
              aria-label={t('chat.responding')}
              className={parts.at(-1)?.kind === 'text' ? 'contents' : undefined}
            >
              {parts.length === 0 && (
                <span className={`text-sm ${ui.muted}`}>{t('chat.thinking')}</span>
              )}
              {parts.at(-1)?.kind !== 'text' && <span className="stream-cursor" />}
            </span>
          )}
        </div>
        {message.status === 'cancelled' && (
          <p data-testid="message-cancelled" className={`mt-1 text-xs ${ui.muted}`}>
            {t('chat.stopped')}
          </p>
        )}
        {message.status === 'error' && (
          <div
            role="alert"
            data-testid="message-error"
            data-code={message.error?.code ?? 'internal'}
            className="mt-2 flex items-center gap-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            <span className="flex-1">{t(`errors.${message.error?.code ?? 'internal'}`)}</span>
            {retry && (
              <button data-testid="retry" className={ui.button} onClick={retry}>
                {t('chat.retry')}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
});
