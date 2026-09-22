import * as Localization from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { Platform } from 'react-native';

import {
  DEFAULT_LANGUAGE,
  isRTLLanguage,
  resolveLanguage,
} from '@/features/preferences/resolve-language';

import en from './locales/en.json';
import he from './locales/he.json';

// The DEVICE language, not the rider's stored preference -- reading that means
// touching AsyncStorage, which is async, and this module initialises i18n
// synchronously at import so the very first render always has strings. The
// preferences provider applies a stored override immediately afterwards, while
// the splash screen is still up, so the device language is never actually seen
// on screen when an override exists.
const language = resolveLanguage('device', Localization.getLocales()[0]?.languageCode ?? undefined);
const isRTL = isRTLLanguage(language);

// react-native-web's I18nManager is a no-op stub (isRTL always false) -- on web,
// CSS `dir` is what flips `flexDirection: 'row'` and text alignment instead.
// `document` doesn't exist during Expo's static-web SSR pass, only in the browser.
//
// Native direction is deliberately NOT touched here. This module only knows the
// DEVICE language, and the native flags only matter to the NEXT launch anyway;
// the preferences provider owns them (see `applyLayoutDirection`).
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  document.documentElement.lang = language;
}

i18n.use(initReactI18next).init({
  resources: {
    he: { translation: he },
    en: { translation: en },
  },
  lng: language,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
});

export default i18n;
