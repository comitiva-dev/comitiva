import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolResultBlock, ToolUseBlock } from '@comitiva/contract';
import { formatInput, resultText } from '../../lib/chat';
import { ui } from '../ui';

/**
 * One tool call, collapsed to its name and state; expanded it shows the
 * arguments, the result and the duration. Approval cards arrive in Phase 5.
 */
export function ToolCallBlock({
  use,
  result,
  running,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  /** The reply is still streaming, so a missing result is pending rather than lost. */
  running: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const state = result ? (result.isError ? 'error' : 'done') : running ? 'running' : 'none';
  return (
    <div
      data-testid="tool-call"
      data-state={state}
      className="rounded-md border border-neutral-200 text-sm dark:border-neutral-800"
    >
      <button
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
      >
        <span aria-hidden className={ui.muted}>
          {open ? '▾' : '▸'}
        </span>
        <span className="font-mono text-xs">{use.name}</span>
        <span className={`ml-auto text-xs ${state === 'error' ? ui.bad : ui.muted}`}>
          {t(`chat.tool.${state}`)}
          {result?.durationMs !== undefined &&
            ` · ${t('chat.tool.duration', { ms: Math.round(result.durationMs) })}`}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <p className={`text-xs ${ui.muted}`}>{t('chat.tool.input')}</p>
          <pre className="max-h-60 overflow-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-neutral-800">
            {formatInput(use.input)}
          </pre>
          {result && (
            <>
              <p className={`text-xs ${ui.muted}`}>{t('chat.tool.output')}</p>
              <pre className="max-h-60 overflow-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-neutral-800">
                {resultText(result) || '—'}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
