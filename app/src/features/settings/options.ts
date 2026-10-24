import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@/features/journey/types';
import type { MapStylePreference, ThemePreference } from '@/features/preferences/preferences-context';
import type { LanguagePreference } from '@/features/preferences/resolve-language';
import type { TimeFormat } from '@/lib/time-format';

/** `device` first in both lists: it is the default, and the option a rider who
 *  opened this screen by accident should find already selected. */
export const LANGUAGE_OPTIONS: { value: LanguagePreference; labelKey: string }[] = [
  { value: 'device', labelKey: 'settings.deviceDefault' },
  { value: 'he', labelKey: 'settings.languageHebrew' },
  { value: 'en', labelKey: 'settings.languageEnglish' },
];

// "System", not the language list's "Device default": it also shows as the
// value beside the Appearance row, where the long form has no room, and iOS
// names this choice "System" too.
export const THEME_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: 'device', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
];

/** "Match the app" first: it is the default, and what the map did before
 *  this setting existed. */
export const MAP_STYLE_OPTIONS: { value: MapStylePreference; labelKey: string }[] = [
  { value: 'app', labelKey: 'settings.mapStyleApp' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
];

export const TIME_FORMAT_OPTIONS: { value: TimeFormat; labelKey: string }[] = [
  { value: 'countdown', labelKey: 'settings.timeFormatCountdown' },
  { value: 'clock', labelKey: 'settings.timeFormatClock' },
];

export type LeadTimeValue = 'oneStop' | 'twoStops' | 'threeMinutes' | 'fiveMinutes';

/**
 * Four choices over TWO triggers, which is the thing to understand before
 * changing this table: `leadStops` and `leadSeconds` are not one setting in
 * two units. The machine counts stops whenever it has a fix and falls back to
 * the clock when it does not, so a stop choice sets `leadStops` and leaves
 * `leadSeconds` at the default (still the fallback for a rider in a tunnel),
 * while a minutes choice sets `leadSeconds` and drops `leadStops` to zero,
 * handing the decision to the clock the rider just chose.
 */
export const LEAD_TIME_OPTIONS: {
  value: LeadTimeValue;
  labelKey: string;
  lead: Pick<AlertSettings, 'leadStops' | 'leadSeconds'>;
}[] = [
  {
    value: 'oneStop',
    labelKey: 'settings.alertLeadOneStop',
    lead: { leadStops: 1, leadSeconds: DEFAULT_ALERT_SETTINGS.leadSeconds },
  },
  {
    value: 'twoStops',
    labelKey: 'settings.alertLeadTwoStops',
    lead: { leadStops: 2, leadSeconds: DEFAULT_ALERT_SETTINGS.leadSeconds },
  },
  { value: 'threeMinutes', labelKey: 'settings.alertLeadThreeMinutes', lead: { leadStops: 0, leadSeconds: 180 } },
  { value: 'fiveMinutes', labelKey: 'settings.alertLeadFiveMinutes', lead: { leadStops: 0, leadSeconds: 300 } },
];

/** Which option a stored pair lights up. A pair that matches nothing (an
 *  older blob, or a hand-edited one) shows the default rather than leaving
 *  the control blank, so the rider always sees a choice they can move off. */
export function leadTimeOption(settings: AlertSettings) {
  return (
    LEAD_TIME_OPTIONS.find(
      (option) =>
        option.lead.leadStops === settings.leadStops && option.lead.leadSeconds === settings.leadSeconds,
    ) ?? LEAD_TIME_OPTIONS[0]
  );
}

/** The label key of the option in `options` whose value is `value`. */
export function labelKeyFor<T>(options: { value: T; labelKey: string }[], value: T): string {
  return (options.find((option) => option.value === value) ?? options[0]).labelKey;
}
