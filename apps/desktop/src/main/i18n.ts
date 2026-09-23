import i18next from 'i18next';
import type { LanguageSetting } from '@comitiva/contract';
// One set of strings for the whole app: main's live under `main.*` in the
// renderer's locale files, so translators see them together.
import en from '../renderer/src/i18n/en.json';
import { resolveLanguage, type Language } from '../renderer/src/i18n/language';
import ptBR from '../renderer/src/i18n/pt-BR.json';

const i18n = i18next.createInstance();
void i18n.init({
  resources: { en: { translation: en }, 'pt-BR': { translation: ptBR } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
});

/** Main's strings (menu, dialogs, the OAuth result page) in the UI language. */
export const t = (key: string, options?: Record<string, unknown>): string =>
  i18n.t(key, options ?? {}) as string;

/** Applies a language setting; returns the language now in use. */
export function setLanguage(setting: LanguageSetting, systemLocale: string): Language {
  const language = resolveLanguage(setting, systemLocale);
  if (i18n.language !== language) void i18n.changeLanguage(language);
  return language;
}
