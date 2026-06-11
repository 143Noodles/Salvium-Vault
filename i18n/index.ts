import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation files
import enTranslation from './locales/en/translation.json';
import esTranslation from './locales/es/translation.json';
import zhTranslation from './locales/zh/translation.json';
import plTranslation from './locales/pl/translation.json';
import ruTranslation from './locales/ru/translation.json';
import deTranslation from './locales/de/translation.json';
import frTranslation from './locales/fr/translation.json';
import nlTranslation from './locales/nl/translation.json';
import koTranslation from './locales/ko/translation.json';
import ptTranslation from './locales/pt/translation.json';
import trTranslation from './locales/tr/translation.json';
import svTranslation from './locales/sv/translation.json';
import arTranslation from './locales/ar/translation.json';
import idTranslation from './locales/id/translation.json';

// Language configuration
export const SUPPORTED_LANGUAGES = {
  'en-US': { name: 'English (US)', nativeName: 'English (US)', flag: '🇺🇸' },
  'en-GB': { name: 'English (UK)', nativeName: 'English (UK)', flag: '🇬🇧' },
  es: { name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  zh: { name: 'Chinese', nativeName: '简体中文', flag: '🇨🇳' },
  pl: { name: 'Polish', nativeName: 'Polski', flag: '🇵🇱' },
  ru: { name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  de: { name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  fr: { name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  nl: { name: 'Dutch', nativeName: 'Nederlands', flag: '🇳🇱' },
  ko: { name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  pt: { name: 'Portuguese', nativeName: 'Português', flag: '🇧🇷' },
  tr: { name: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷' },
  sv: { name: 'Swedish', nativeName: 'Svenska', flag: '🇸🇪' },
  ar: { name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦' },
  id: { name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '🇮🇩' }
} as const;

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES;

// LocalStorage key for language preference (follows existing pattern)
const LANGUAGE_STORAGE_KEY = 'salvium_language';

// Initialize i18next
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'en-US': { translation: enTranslation },
      'en-GB': { translation: enTranslation },
      es: { translation: esTranslation },
      zh: { translation: zhTranslation },
      pl: { translation: plTranslation },
      ru: { translation: ruTranslation },
      de: { translation: deTranslation },
      fr: { translation: frTranslation },
      nl: { translation: nlTranslation },
      ko: { translation: koTranslation },
      pt: { translation: ptTranslation },
      tr: { translation: trTranslation },
      sv: { translation: svTranslation },
      ar: { translation: arTranslation },
      id: { translation: idTranslation }
    },
    fallbackLng: 'en-US',
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),

    // Map detected languages to supported ones
    load: 'currentOnly',

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      // Normalize browser language variants to the wallet's supported locale keys.
      convertDetectedLanguage: (lng: string) => {
        const normalized = lng.toLowerCase();
        if (normalized === 'id' || normalized.startsWith('id-')) return 'id';
        if (lng === 'en') return 'en-US';
        if (lng.startsWith('en-') && lng !== 'en-US' && lng !== 'en-GB') return 'en-GB';
        return lng;
      }
    },

    interpolation: {
      escapeValue: false
    },

    react: {
      useSuspense: false
    },

    // Ensure synchronous initialization
    initImmediate: false
  });

// Helper to change language and persist
export const changeLanguage = async (lang: SupportedLanguage): Promise<void> => {
  await i18n.changeLanguage(lang);
  localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
};

// Helper to get current language
export const getCurrentLanguage = (): SupportedLanguage => {
  const lang = i18n.language || 'en-US';
  // Return exact match if it's a supported language
  if (lang in SUPPORTED_LANGUAGES) return lang as SupportedLanguage;
  // Default to en-US for any unrecognized language
  return 'en-US';
};

export default i18n;
