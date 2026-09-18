import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ptBR from './pt-BR.json';

export const resources = { en: { translation: en }, 'pt-BR': { translation: ptBR } } as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: navigator.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
