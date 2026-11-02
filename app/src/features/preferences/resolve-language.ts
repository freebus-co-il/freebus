/** The languages the app's own interface is written in. */
export const SUPPORTED_LANGUAGES = ['he', 'en', 'ar', 'ru', 'es'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * The languages the GTFS feed itself translates stop, line and place names
 * into: its `translations.txt` ships exactly HE, EN and AR, and the API
 * rejects any other `lang`.
 */
export const FEED_LANGUAGES = ['he', 'en', 'ar'] as const;
export type FeedLanguage = (typeof FEED_LANGUAGES)[number];

/**
 * The language to ask the API for names in. An interface language the feed
 * has no names for (Russian, Spanish) gets English names: Latin script a
 * visitor can read and match to the signs, where the feed's untranslated
 * fallback would be Hebrew.
 */
export function feedLanguage(language: string): FeedLanguage {
  return (FEED_LANGUAGES as readonly string[]).includes(language) ? (language as FeedLanguage) : 'en';
}

/** What the rider chose in settings. `device` is not a language -- it defers to
 *  whatever the phone is set to, and re-resolves if that later changes. */
export type LanguagePreference = 'device' | SupportedLanguage;

/** What a phone set to a language this app does not speak gets: English is the
 *  one a visitor or a new immigrant is likeliest to read. */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

const RTL_LANGUAGES: readonly SupportedLanguage[] = ['he', 'ar'];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly unknown[]).includes(value);
}

export function isRTLLanguage(language: SupportedLanguage): boolean {
  return RTL_LANGUAGES.includes(language);
}

/** The language actually shown, given the stored preference and the device's
 *  own locale. Pure, so the boot path and the settings screen can both ask. */
export function resolveLanguage(
  preference: LanguagePreference,
  deviceLanguage: string | undefined,
): SupportedLanguage {
  if (preference !== 'device') return preference;
  // `iw` is the legacy code some Android versions still report for Hebrew.
  const code = deviceLanguage?.toLowerCase() === 'iw' ? 'he' : deviceLanguage?.toLowerCase();
  return isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
}

/**
 * Whether a launch laid out one way (`layoutIsRTL`, what `I18nManager.isRTL`
 * reported when it started) must restart to show `language` properly -- the
 * native direction can only change across a restart.
 *
 * Compared against the RUNNING layout, not the previous language: the layout
 * can disagree with a language that never changed. The phone's language can
 * move under a "device default" rider, and a direction flag written by an older
 * build can be stale -- both used to leave Hebrew in a left-to-right layout
 * until something happened to flip the flags back.
 *
 * `language` must already be RESOLVED, never a raw `device` preference:
 * choosing "device default" on a phone already in that language changes what
 * is stored while changing nothing the rider can see.
 */
export function needsDirectionRestart(language: SupportedLanguage, layoutIsRTL: boolean): boolean {
  return isRTLLanguage(language) !== layoutIsRTL;
}
