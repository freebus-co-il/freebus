import * as Updates from 'expo-updates';
import { DevSettings, I18nManager, Platform } from 'react-native';

import {
  isRTLLanguage,
  needsDirectionRestart,
  type SupportedLanguage,
} from '@/features/preferences/resolve-language';

/**
 * The one place layout direction is decided. Everything else READS
 * `I18nManager.isRTL` (or better, uses logical styles and never asks) and
 * never writes it.
 *
 * React Native fixes a launch's direction natively, before any JS runs, from
 * two persisted flags -- `allowRTL` and `forceRTL` -- and the device language:
 *
 *     isRTL = forceRTL || (allowRTL && device language is RTL)
 *
 * Which is why BOTH flags are pinned to the app's language rather than just
 * `forceRTL`: `forceRTL(false)` alone does not make a launch LTR on a Hebrew
 * phone, it leaves `allowRTL` to mirror English text anyway. With both set
 * from the same boolean, the device language drops out of the equation and a
 * launch runs the way the APP's language reads, whatever the phone is set to.
 *
 * Nothing else may write these flags. `expo-localization` will, on every iOS
 * launch, if its `supportsRTL` option is set -- from the device locale, over
 * the top of whatever the app chose -- which is why app.json leaves it unset.
 *
 * Returns whether the RUNNING layout disagrees with `language`. The flags only
 * take hold on the next launch, so a `true` here means the caller restarts.
 */
export function applyLayoutDirection(language: SupportedLanguage): boolean {
  const rtl = isRTLLanguage(language);

  if (Platform.OS === 'web') {
    // react-native-web's I18nManager is a stub; CSS `dir` flips flex rows and
    // text alignment there, and takes effect immediately, so no restart.
    if (typeof document !== 'undefined') {
      document.documentElement.dir = rtl ? 'rtl' : 'ltr';
      document.documentElement.lang = language;
    }
    return false;
  }

  /* eslint-disable no-restricted-syntax -- this is the one place allowed to */
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  /* eslint-enable no-restricted-syntax */
  return needsDirectionRestart(language, I18nManager.isRTL);
}

/** Whether this launch is already laid out the way `language` reads. Pure
 *  read, safe during render; web is always right (CSS `dir` applies live). */
export function layoutMatchesLanguage(language: SupportedLanguage): boolean {
  return Platform.OS === 'web' || !needsDirectionRestart(language, I18nManager.isRTL);
}

/**
 * Restarts the JS app so a new direction takes hold. Resolves `false` when no
 * restart could be started -- a release build whose `expo-updates` refuses --
 * so the caller can show the app rather than wait behind the splash forever.
 */
export async function restartApp(): Promise<boolean> {
  try {
    await Updates.reloadAsync();
    return true;
  } catch {
    // `expo-updates` refuses to run in a development build; React Native's own
    // dev reload is the equivalent there.
    if (__DEV__) {
      DevSettings.reload();
      return true;
    }
    return false;
  }
}

/**
 * `textAlign` for text that starts where its line starts: the left edge in
 * English, the right edge in Hebrew.
 *
 * It is `'left'`, in both directions. React Native already treats `left` and
 * `right` on `<Text>` as start and end once the layout runs RTL -- on iOS and
 * Android alike -- so `isRTL ? 'right' : 'left'` mirrors TWICE and puts Hebrew
 * back against the left edge. Nor is `auto` a substitute: it aligns by the
 * script of the text itself, so a Hebrew stop name in the English UI would
 * jump to the right.
 */
export const TEXT_ALIGN_START = 'left' as const;

/**
 * The same, for `<TextInput>` -- which, unlike `<Text>`, React Native does NOT
 * mirror: on both iOS and Android an input's `left`/`right` is the physical
 * side, so here (and only here) the side has to be named per direction.
 */
export const INPUT_ALIGN_START: 'left' | 'right' =
  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned case, see above
  I18nManager.isRTL ? 'right' : 'left';
