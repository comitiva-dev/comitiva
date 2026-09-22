import { useTranslation } from 'react-i18next';
import type { ToolDef } from '@comitiva/contract';
import type { Async } from '../lib/async';
import { toolBadges, type ToolBadge } from '../lib/toolServerForm';
import { ui } from './ui';

const BADGE_CLASS: Record<ToolBadge, string> = {
  readOnly: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  asks: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  destructive: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300',
  noAnnotations: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
};

/** A server's "Test" result: busy, the error, or its tools with what each one does to approvals. */
export function ToolTestResult({ test }: { test: Async<ToolDef[]> }) {
  const { t } = useTranslation();
  if (test.state === 'idle') return null;
  return (
    <div data-testid="test-result" data-state={test.state} className="mt-2 text-xs">
      {test.state === 'busy' ? (
        <span className={ui.muted}>{t('tools.testing')}</span>
      ) : test.state === 'failed' ? (
        <span className={ui.bad}>{t(`errors.${test.code}`)}</span>
      ) : (
        <>
          <p className={ui.ok}>{t('tools.toolCount', { count: test.value.length })}</p>
          <ul className="mt-1 flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
            {test.value.map((tool) => (
              <li
                key={tool.name}
                data-testid="tool-name"
                data-tool={tool.name}
                className="flex flex-col gap-0.5 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono font-medium">{tool.name}</span>
                  {tool.title && tool.title !== tool.name && (
                    <span className={ui.muted}>{tool.title}</span>
                  )}
                  {toolBadges(tool).map((badge) => (
                    <span
                      key={badge}
                      data-testid="tool-badge"
                      data-badge={badge}
                      title={t(`tools.badges.${badge}Hint`)}
                      className={`rounded px-1.5 py-0.5 ${BADGE_CLASS[badge]}`}
                    >
                      {t(`tools.badges.${badge}`)}
                    </span>
                  ))}
                </div>
                {tool.description && (
                  <p className={`line-clamp-2 ${ui.muted}`} title={tool.description}>
                    {tool.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
