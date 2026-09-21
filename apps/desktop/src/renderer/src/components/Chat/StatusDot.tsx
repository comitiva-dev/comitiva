import { useTranslation } from 'react-i18next';
import type { ConversationStatus } from '@comitiva/contract';
import type { AgentStatus } from '../../store/conversations';

const colors: Record<ConversationStatus, string> = {
  idle: 'bg-neutral-300 dark:bg-neutral-600',
  running: 'bg-indigo-500 animate-pulse',
  'awaiting-approval': 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
};

/** Idle, responding, awaiting approval or error; for an agent (sidebar) or a conversation. */
export function StatusDot({
  status,
  testId,
}: {
  status: ConversationStatus | AgentStatus;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-testid={testId}
      data-status={status}
      title={t(`agents.status.${status}`)}
      className={`h-2 w-2 shrink-0 rounded-full ${colors[status]}`}
    />
  );
}
