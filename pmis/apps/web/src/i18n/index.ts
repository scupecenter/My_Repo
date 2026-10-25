import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ar from './ar.json';

export type Locale = 'en' | 'ar';
const saved = (): Locale => (localStorage.getItem('pmis.locale') === 'ar' ? 'ar' : 'en');

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng: saved(), fallbackLng: 'en', interpolation: { escapeValue: false },
});

/** Sets lang + dir on <html>; logical CSS does the rest. */
export function applyLocale(l: Locale) {
  localStorage.setItem('pmis.locale', l);
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
  void i18n.changeLanguage(l);
}
export function applyTheme(t: 'light' | 'dark') {
  localStorage.setItem('pmis.theme', t);
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}
export const currentLocale = (): Locale => (i18n.language === 'ar' ? 'ar' : 'en');
export const currentTheme = (): 'light' | 'dark' => (localStorage.getItem('pmis.theme') === 'dark' ? 'dark' : 'light');
export default i18n;
