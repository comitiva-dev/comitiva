import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '@comitiva/contract';
import {
  canSendDraft,
  formatSize,
  pickedFromFile,
  type DraftAttachment,
  type PickedFile,
} from '../../lib/attachments';
import { composerKey } from '../../lib/chat';
import { ui } from '../ui';

const MAX_HEIGHT = 240;

/**
 * Text input for a conversation. Enter sends, Shift+Enter adds a line
 * break. While a reply streams the button becomes Stop. Files are attached
 * with the button, by dropping them or by pasting; each is stored at once
 * and shown as a chip. The draft lives in the store, so it survives
 * switching conversations.
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
  attachments = [],
  onAttach,
  onDetach,
  attachmentUrl,
  imagesHint,
  attachRequest = 0,
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
  attachments?: readonly DraftAttachment[] | undefined;
  onAttach?: ((files: PickedFile[]) => void) | undefined;
  onDetach?: ((id: string) => void) | undefined;
  attachmentUrl?: ((path: string) => string) | undefined;
  /** Shown when images are attached and the agent's connection cannot see them. */
  imagesHint?: string | null | undefined;
  /** Bumped by the attach shortcut: opens the file picker. */
  attachRequest?: number | undefined;
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const seenAttachRequest = useRef(attachRequest);

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

  useEffect(() => {
    if (attachRequest === seenAttachRequest.current) return;
    seenAttachRequest.current = attachRequest;
    if (onAttach && !disabledReason) fileInput.current?.click();
  }, [attachRequest, onAttach, disabledReason]);

  const blocked = Boolean(disabledReason);
  const canSend = !blocked && !running && !sending && canSendDraft(value, attachments);
  const attach = (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (list.length > 0 && onAttach && !blocked) onAttach(list.map(pickedFromFile));
  };
  const showImagesHint = Boolean(imagesHint) && attachments.some((a) => a.isImage);

  return (
    <div
      data-testid="composer-area"
      data-dragging={dragging || undefined}
      className={`relative border-t border-neutral-200 px-6 py-3 dark:border-neutral-800 ${
        dragging ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''
      }`}
      onDragOver={(e) => {
        if (!onAttach || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!onAttach) return;
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium text-indigo-700 dark:text-indigo-300">
          {t('chat.dropHere')}
        </p>
      )}
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
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label={t('chat.attach')}>
          {attachments.map((a) => {
            const thumb =
              a.isImage &&
              a.block?.type === 'image' &&
              a.block.source.kind === 'file' &&
              attachmentUrl
                ? attachmentUrl(a.block.source.path)
                : null;
            return (
              <li
                key={a.id}
                data-testid="attachment-chip"
                data-status={a.status}
                data-error={a.error}
                title={a.error ? t(`errors.${a.error}`) : a.name}
                className={`flex max-w-60 items-center gap-2 rounded-md border px-2 py-1 text-xs ${
                  a.status === 'failed'
                    ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
                    : 'border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900'
                }`}
              >
                {thumb ? (
                  <img src={thumb} alt="" className="h-8 w-8 rounded object-cover" />
                ) : (
                  <span aria-hidden className="text-base">
                    {a.isImage ? '🖼' : '📄'}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{a.name}</span>
                  <span className={a.status === 'failed' ? '' : ui.muted}>
                    {a.status === 'uploading'
                      ? t('chat.uploading')
                      : a.status === 'failed' && a.error
                        ? t(`errors.${a.error}`)
                        : formatSize(a.size, i18n.language)}
                  </span>
                </span>
                {onDetach && (
                  <button
                    data-testid="attachment-remove"
                    className={ui.ghost}
                    onClick={() => onDetach(a.id)}
                    aria-label={t('chat.removeAttachment', { name: a.name })}
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {showImagesHint && (
        <p
          data-testid="composer-images-hint"
          className="mb-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {imagesHint}
        </p>
      )}
      <div className="flex items-end gap-2">
        {onAttach && (
          <>
            <input
              ref={fileInput}
              data-testid="attach-input"
              type="file"
              multiple
              hidden
              onChange={(e) => {
                attach(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              data-testid="attach"
              className={ui.button}
              disabled={blocked}
              onClick={() => fileInput.current?.click()}
              aria-label={t('chat.attach')}
              title={t('chat.attach')}
            >
              📎
            </button>
          </>
        )}
        <textarea
          ref={ref}
          data-testid="composer"
          rows={1}
          value={value}
          disabled={blocked}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            if (!onAttach || e.clipboardData.files.length === 0) return;
            e.preventDefault();
            attach(e.clipboardData.files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && running && onStop) {
              e.preventDefault();
              onStop();
              return;
            }
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
