import { useTranslation } from 'react-i18next';
import type { ApprovalDecision, ToolUseBlock } from '@comitiva/contract';
import { approvalTargets, formatInput, toolLabel } from '../../lib/chat';
import { ui } from '../ui';

/**
 * Asks before a tool call that changes something runs: Allow (this call),
 * Deny, or Always allow (this tool, for this agent). The run waits for the
 * answer; the conversation shows as awaiting approval meanwhile.
 */
export function ApprovalCard({
  use,
  serverName,
  agentName,
  busy,
  onDecide,
}: {
  use: ToolUseBlock;
  serverName: string;
  agentName: string;
  /** A decision is on its way: the buttons are disabled. */
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const { t } = useTranslation();
  const { tool } = toolLabel(use);
  const targets = approvalTargets(use.input);
  const input = (
    <pre className="max-h-40 overflow-auto rounded bg-amber-100/60 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-amber-900/40">
      {formatInput(use.input)}
    </pre>
  );
  return (
    <div
      role="group"
      aria-label={t('approval.label')}
      data-testid="approval-card"
      className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <p>{t('approval.question', { agent: agentName, tool, server: serverName })}</p>
      {targets.length > 0 ? (
        <>
          <ul className="flex flex-col gap-0.5" data-testid="approval-targets">
            {targets.map((target) => (
              <li key={target} className="font-mono text-xs break-all">
                {target}
              </li>
            ))}
          </ul>
          <details className="text-xs">
            <summary className="cursor-pointer select-none">{t('approval.details')}</summary>
            {input}
          </details>
        </>
      ) : (
        input
      )}
      <div className="flex flex-wrap gap-2">
        <button
          data-testid="approve-allow"
          className={ui.primary}
          disabled={busy}
          onClick={() => onDecide('allow')}
        >
          {t('approval.allow')}
        </button>
        <button
          data-testid="approve-deny"
          className={ui.button}
          disabled={busy}
          onClick={() => onDecide('deny')}
        >
          {t('approval.deny')}
        </button>
        <button
          data-testid="approve-always"
          className={ui.button}
          disabled={busy}
          title={t('approval.alwaysHint', { tool, agent: agentName })}
          onClick={() => onDecide('allow-always')}
        >
          {t('approval.always')}
        </button>
      </div>
    </div>
  );
}
