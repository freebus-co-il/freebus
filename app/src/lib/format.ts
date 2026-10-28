import i18n from '@/i18n';

/**
 * These read the i18n singleton rather than a `t` from `useTranslation()` so
 * they stay callable from plain helpers. That's safe here because the language
 * is resolved once at startup and can't change without a full app reload (see
 * `src/i18n/index.ts`); a future in-app language switcher would need to thread
 * `t` through instead.
 */

/**
 * `toLocale*` calls need an explicit BCP-47 tag here -- passing `[]` defers to
 * the device's OS-level region format, which can disagree with the app's own
 * `i18n.language` (e.g. an English-region device running the Hebrew UI), and
 * shows up as a stray English date sitting inside an otherwise-Hebrew screen.
 */
const LOCALE_TAGS: Record<string, string> = { he: 'he-IL', en: 'en-US' };
function currentLocaleTag(): string {
  return LOCALE_TAGS[i18n.language] ?? 'en-US';
}

export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(currentLocaleTag(), { hour: '2-digit', minute: '2-digit' });
}

export function formatDurationMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return i18n.t('units.minutes', { value: minutes });
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? i18n.t('units.hours', { value: hours })
    : i18n.t('units.hoursMinutes', { hours, minutes: remainder });
}

export function formatPickerDateTime(date: Date, referenceNow: Date): string {
  const locale = currentLocaleTag();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === referenceNow.toDateString()) return time;
  const day = date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  return i18n.t('units.dateAtTime', { date: day, time });
}

export function formatDistanceMeters(meters: number): string {
  if (meters < 1000) return i18n.t('units.meters', { value: Math.round(meters) });
  return i18n.t('units.kilometers', { value: (meters / 1000).toFixed(1) });
}

/**
 * "today" / "tomorrow" / a weekday name, for a date far enough away that a
 * bare clock time would mislead.
 *
 * The empty departure board is the caller that needs this: on Shabbat the
 * next bus is often the better part of a day out, and "19:32" alone reads as
 * tonight whether it is tonight or Sunday. Compares CALENDAR DAYS rather than
 * elapsed hours -- 23:50 to 00:10 is tomorrow even though it is twenty
 * minutes away, which is exactly how a rider would say it.
 */
export function formatRelativeDay(iso: string, referenceNow: Date = new Date()): string {
  const date = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(referenceNow)) / 86_400_000);
  if (days <= 0) return i18n.t('units.today');
  if (days === 1) return i18n.t('units.tomorrow');
  // Past tomorrow a weekday name is what people actually say, and this never
  // runs more than eight days out (the API's own lookahead limit), so a
  // weekday is never ambiguous between two different weeks.
  return date.toLocaleDateString(currentLocaleTag(), { weekday: 'long' });
}
