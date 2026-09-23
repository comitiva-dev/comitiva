import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTransfer } from '../store/context';
import { ui } from './ui';

/**
 * What an export or import did: a short confirmation with the saved path, an
 * error by code, or the import report with what is left to finish.
 */
export function TransferFeedback() {
  const { t } = useTranslation();
  const saved = useTransfer((s) => s.saved);
  const notice = useTransfer((s) => s.notice);
  const report = useTransfer((s) => s.report);
  const dismiss = useTransfer((s) => s.dismiss);

  // The confirmation fades on its own; errors and reports wait for the user.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [saved, dismiss]);

  if (report) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={dismiss}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-title"
          data-testid="import-report"
          className={`${ui.card} w-full max-w-md p-5 shadow-xl`}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="import-title" className="text-base font-semibold">
            {t('settings.data.imported')}
          </h2>
          <p data-testid="import-counts" className={`mt-2 text-sm ${ui.muted}`}>
            {t('settings.data.counts', {
              agents: t('settings.data.nAgents', { count: report.agents }),
              connections: t('settings.data.nConnections', { count: report.connections }),
              toolServers: t('settings.data.nToolServers', { count: report.toolServers }),
            })}
          </p>
          {report.warnings.length > 0 && (
            <>
              <p className="mt-3 text-sm font-medium">{t('settings.data.todo')}</p>
              <ul className="mt-1 flex max-h-60 flex-col gap-1 overflow-y-auto text-sm">
                {report.warnings.map((w, i) => (
                  <li
                    key={i}
                    data-testid="import-warning"
                    data-code={w.code}
                    className="flex gap-2"
                  >
                    <span aria-hidden>•</span>
                    <span>
                      {t(`settings.data.warning.${w.code}`, {
                        subject: w.subject,
                        detail: w.detail ?? '',
                        error: w.error ? t(`errors.${w.error}`) : '',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-5 flex justify-end">
            <button data-testid="import-report-close" className={ui.primary} onClick={dismiss}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!saved && !notice) return null;
  return (
    <div
      role={notice ? 'alert' : 'status'}
      data-testid={notice ? 'transfer-error' : 'transfer-saved'}
      data-code={notice ?? undefined}
      className={`fixed bottom-4 right-4 z-40 flex max-w-md items-start gap-3 rounded-md border p-3 text-sm shadow-lg ${
        notice
          ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
          : 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900'
      }`}
    >
      <span className="min-w-0 break-all">
        {notice ? t(`errors.${notice}`) : t('settings.data.saved', { path: saved })}
      </span>
      <button className={ui.ghost} onClick={dismiss} aria-label={t('common.dismiss')}>
        ✕
      </button>
    </div>
  );
}
