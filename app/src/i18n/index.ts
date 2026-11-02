import * as Localization from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  DEFAULT_LANGUAGE,
  resolveLanguage,
} from '@/features/preferences/resolve-language';

import ar from './locales/ar.json';
import en from './locales/en.json';
import es from './locales/es.json';
import he from './locales/he.json';
import ru from './locales/ru.json';

// The DEVICE language, not the rider's stored preference -- reading that means
// touching AsyncStorage, which is async, and this module initialises i18n
// synchronously at import so the very first render always has strings. The
// preferences provider applies a stored override immediately afterwards, while
// the splash screen is still up, so the device language is never actually seen
// on screen when an override exists.
const language = resolveLanguage('device', Localization.getLocales()[0]?.languageCode ?? undefined);

// Direction is deliberately NOT touched here. This module only knows the
// DEVICE language, and the native flags only matter to the NEXT launch anyway;
// the preferences provider owns them (see `applyLayoutDirection`).

i18n.use(initReactI18next).init({
  resources: {
    he: { translation: he },
    en: { translation: en },
    ar: { translation: ar },
    ru: { translation: ru },
    es: { translation: es },
  },
  lng: language,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
});

export default i18n;
