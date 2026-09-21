import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ui } from './ui';

/** In-app confirmation (never window.confirm, which blocks the renderer). */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  blocked,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** Shown instead of allowing the action: the reason it cannot happen now. */
  blocked?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        data-testid="confirm-dialog"
        className={`${ui.card} w-full max-w-sm p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-base font-semibold">
          {title}
        </h2>
        {blocked ?? <p className={`mt-2 text-sm ${ui.muted}`}>{body}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            data-testid="confirm-cancel"
            className={ui.button}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            data-testid="confirm-ok"
            className={`${ui.danger} disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={blocked !== undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
