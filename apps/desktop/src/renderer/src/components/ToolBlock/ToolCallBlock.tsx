import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolResultBlock, ToolUseBlock } from '@comitiva/contract';
import { formatInput, resultText, toolLabel, type ToolState } from '../../lib/chat';
import { ui } from '../ui';

const stateClass: Record<ToolState, string> = {
  awaiting: 'text-amber-700 dark:text-amber-300',
  running: ui.muted,
  done: ui.muted,
  error: ui.bad,
  denied: ui.bad,
  none: ui.muted,
};

/**
 * One tool call, collapsed to its tool, server and state; expanded it shows
 * the arguments, the result and the duration.
 */
export function ToolCallBlock({
  use,
  result,
  state,
  serverName,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  state: ToolState;
  /** The server's display name; null for a harness's own tools. */
  serverName: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { tool } = toolLabel(use);
  return (
    <div
      data-testid="tool-call"
      data-state={state}
      data-tool={tool}
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
        <span className="font-mono text-xs">{tool}</span>
        {serverName && <span className={`text-xs ${ui.muted}`}>· {serverName}</span>}
        <span className={`ml-auto text-xs ${stateClass[state]}`}>
          {t(`chat.tool.${state}`)}
          {result?.durationMs !== undefined &&
            state !== 'denied' &&
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
              <pre
                data-testid="tool-output"
                className="max-h-60 overflow-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-neutral-800"
              >
                {resultText(result) || '—'}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
