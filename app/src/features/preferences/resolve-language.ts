export const SUPPORTED_LANGUAGES = ['he', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** What the rider chose in settings. `device` is not a language -- it defers to
 *  whatever the phone is set to, and re-resolves if that later changes. */
export type LanguagePreference = 'device' | SupportedLanguage;

/** An Israeli transit app: a rider whose phone speaks something this app does
 *  not is likelier to read Hebrew than to be helped by an English fallback. */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'he';

const RTL_LANGUAGES: readonly SupportedLanguage[] = ['he'];

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
  return SUPPORTED_LANGUAGES.find((language) => language === deviceLanguage) ?? DEFAULT_LANGUAGE;
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
