import type { LanguageSetting } from '@comitiva/contract';

/** The languages the UI ships in. */
export type Language = 'en' | 'pt-BR';

/**
 * The language to show: the user's choice, or for `system` the OS locale
 * (Portuguese of any region → pt-BR, anything else → English). Main uses the
 * same rule for the menu and dialogs, so both sides agree.
 */
export function resolveLanguage(setting: LanguageSetting, systemLocale: string): Language {
  if (setting !== 'system') return setting;
  return systemLocale.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
