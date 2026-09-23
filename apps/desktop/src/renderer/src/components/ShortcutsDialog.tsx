import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  COMPOSER_KEYS,
  SHORTCUTS,
  displayKeys,
  type ShortcutGroup,
} from '../../../shared/shortcuts';
import { isMac } from '../commands';
import { useStoreApis, useUi } from '../store/context';
import { ui } from './ui';

const GROUPS: ShortcutGroup[] = ['navigation', 'conversation', 'app'];

function Keys({ keys, mac }: { keys: string; mac: boolean }) {
  return (
    <span className="flex shrink-0 gap-1">
      {displayKeys(keys, mac).map((k, i) => (
        <kbd
          key={i}
          className="min-w-6 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 text-center font-sans text-xs dark:border-neutral-600 dark:bg-neutral-800"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Every keyboard shortcut, from the same list the key handler and the menu use. */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.shortcutsOpen);
  const stores = useStoreApis();
  const mac = isMac();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && stores.ui.getState().setShortcutsOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, stores]);

  if (!open) return null;
  const close = () => stores.ui.getState().setShortcutsOpen(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-testid="shortcuts-dialog"
        className={`${ui.card} max-h-[80vh] w-full max-w-lg overflow-y-auto p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-base font-semibold">
            {t('shortcuts.title')}
          </h2>
          <button className={ui.ghost} onClick={close} aria-label={t('common.close')}>
            ✕
          </button>
        </header>
        {GROUPS.map((group) => (
          <section key={group} className="mt-4">
            <h3 className={`text-xs font-semibold uppercase tracking-wide ${ui.muted}`}>
              {t(`shortcuts.groups.${group}`)}
            </h3>
            <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <li
                  key={s.command}
                  data-testid="shortcut-row"
                  data-command={s.command}
                  className="flex items-center justify-between gap-4 py-1.5 text-sm"
                >
                  <span>{t(`commands.${s.command}`)}</span>
                  <Keys keys={s.keys} mac={mac} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section className="mt-4">
          <h3 className={`text-xs font-semibold uppercase tracking-wide ${ui.muted}`}>
            {t('shortcuts.groups.composer')}
          </h3>
          <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
            {COMPOSER_KEYS.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>{t(`shortcuts.composer.${k.id}`)}</span>
                <Keys keys={k.keys} mac={mac} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
