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
const LOCALE_TAGS: Record<string, string> = { he: 'he-IL', en: 'en-US', ar: 'ar-IL-u-nu-latn', ru: 'ru-RU', es: 'es-ES' };
function currentLocaleTag(): string {
  return LOCALE_TAGS[i18n.language] ?? 'en-US';
}

/**
 * Arabic's own defaults are Arabic-Indic digits and a 12-hour clock. Neither
 * fits here: line numbers, countdowns and every other number in the app are
 * Western digits (and so are the signs at the stop), and Israeli timetables
 * run on a 24-hour clock in all three languages. The `nu-latn` tag asks for
 * Western digits; `toWesternDigits` still converts afterwards, for an engine
 * that ignores the extension.
 */
function clockOptions(): Intl.DateTimeFormatOptions {
  return i18n.language === 'ar'
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit' };
}

const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
function toWesternDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => String(digit.charCodeAt(0) & 0xf));
}

function localeTime(date: Date): string {
  return toWesternDigits(date.toLocaleTimeString(currentLocaleTag(), clockOptions()));
}

function localeDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return toWesternDigits(date.toLocaleDateString(currentLocaleTag(), options));
}

export function formatClockTime(iso: string): string {
  return localeTime(new Date(iso));
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
  const time = localeTime(date);
  if (date.toDateString() === referenceNow.toDateString()) return time;
  const day = localeDate(date, { weekday: 'short', month: 'short', day: 'numeric' });
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
  return localeDate(date, { weekday: 'long' });
}
