import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '@comitiva/contract';
import { composerKey } from '../../lib/chat';
import { ui } from '../ui';

const MAX_HEIGHT = 240;

/**
 * Text input for a conversation. Enter sends, Shift+Enter adds a line
 * break. While a reply streams the button becomes Stop. The draft lives in
 * the store, so it survives switching conversations.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  sending,
  disabledReason,
  error,
  onDismissError,
  placeholder,
  focusKey,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop?: (() => void) | undefined;
  running: boolean;
  sending: boolean;
  /** Why this agent cannot chat right now (e.g. its connection is disabled). */
  disabledReason?: string | null | undefined;
  error?: ErrorCode | null | undefined;
  onDismissError?: (() => void) | undefined;
  placeholder: string;
  /** Focus moves to the composer whenever this changes (a new conversation opened). */
  focusKey: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);

  // Grows with the text up to MAX_HEIGHT, then scrolls.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, which border-box sizing counts.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, MAX_HEIGHT)}px`;
  }, [value]);

  const blocked = Boolean(disabledReason);
  const canSend = !blocked && !running && !sending && value.trim() !== '';

  return (
    <div className="border-t border-neutral-200 px-6 py-3 dark:border-neutral-800">
      {error && (
        <div
          role="alert"
          data-testid="composer-error"
          data-code={error}
          className="mb-2 flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <span>{t(`errors.${error}`)}</span>
          {onDismissError && (
            <button className={ui.ghost} onClick={onDismissError} aria-label={t('common.dismiss')}>
              ✕
            </button>
          )}
        </div>
      )}
      {disabledReason && (
        <p
          data-testid="composer-blocked"
          className="mb-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {disabledReason}
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          data-testid="composer"
          rows={1}
          value={value}
          disabled={blocked}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (composerKey({ ...e, isComposing: e.nativeEvent.isComposing }) !== 'send') return;
            e.preventDefault();
            if (canSend) onSend();
          }}
          className={`${ui.input} resize-none py-2 leading-5`}
          style={{ maxHeight: MAX_HEIGHT }}
        />
        {running && onStop ? (
          <button data-testid="stop" className={ui.button} onClick={onStop}>
            {t('chat.stop')}
          </button>
        ) : (
          <button data-testid="send" className={ui.primary} disabled={!canSend} onClick={onSend}>
            {t('chat.send')}
          </button>
        )}
      </div>
      <p className={`mt-1 text-xs ${ui.muted}`}>{t('chat.keys')}</p>
    </div>
  );
}
