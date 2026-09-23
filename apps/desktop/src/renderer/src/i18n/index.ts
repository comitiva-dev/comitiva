import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { LanguageSetting } from '@comitiva/contract';
import en from './en.json';
import { resolveLanguage } from './language';
import ptBR from './pt-BR.json';

export const resources = { en: { translation: en }, 'pt-BR': { translation: ptBR } } as const;

// The system's language until the saved preference loads (applyLanguage).
void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage('system', navigator.language),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/** Shows the UI in the language the user chose (or the system's). */
export function applyLanguage(setting: LanguageSetting): void {
  const language = resolveLanguage(setting, navigator.language);
  if (i18n.language !== language) void i18n.changeLanguage(language);
  document.documentElement.lang = language;
}

export default i18n;
