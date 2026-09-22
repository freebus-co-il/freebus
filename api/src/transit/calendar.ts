import type Database from "better-sqlite3";
import { DateTime } from "luxon";

export interface CalendarRow {
  serviceId: string;
  /** Bitmask, bit 0 = Sunday .. bit 6 = Saturday (the feed's column order). */
  days: number;
  start: number;
  end: number;
}

export function loadCalendar(db: Database.Database): CalendarRow[] {
  const rows = db.prepare(`
    SELECT service_id, sunday, monday, tuesday, wednesday, thursday, friday,
           saturday, start_date, end_date FROM calendar
  `).all() as {
    service_id: string; sunday: number; monday: number; tuesday: number;
    wednesday: number; thursday: number; friday: number; saturday: number;
    start_date: number; end_date: number;
  }[];

  return rows.map((r) => ({
    serviceId: r.service_id,
    days: (r.sunday ? 1 : 0) | (r.monday ? 2 : 0) | (r.tuesday ? 4 : 0)
        | (r.wednesday ? 8 : 0) | (r.thursday ? 16 : 0) | (r.friday ? 32 : 0)
        | (r.saturday ? 64 : 0),
    start: r.start_date,
    end: r.end_date,
  }));
}

export function serviceWindow(rows: readonly CalendarRow[]): { start: number; end: number } {
  if (rows.length === 0) return { start: 0, end: 0 };
  let start = Number.MAX_SAFE_INTEGER;
  let end = 0;
  for (const r of rows) {
    if (r.start < start) start = r.start;
    if (r.end > end) end = r.end;
  }
  return { start, end };
}

function dateTimeOfYmd(dateYmd: number, tz: string): DateTime {
  return DateTime.fromObject(
    {
      year: Math.floor(dateYmd / 10000),
      month: Math.floor(dateYmd / 100) % 100,
      day: dateYmd % 100,
    },
    { zone: tz },
  );
}

/**
 * There is no `calendar_dates.txt` in this feed, so `calendar.txt` alone
 * decides service days — there are no exceptions to apply.
 */
export function activeServiceIds(
  rows: readonly CalendarRow[], dateYmd: number, tz = "Asia/Jerusalem",
): Set<string> {
  const out = new Set<string>();
  // Luxon's weekday is 1 = Monday .. 7 = Sunday. The feed's bitmask is
  // 0 = Sunday .. 6 = Saturday, so Sunday (7) maps to bit 0.
  const bit = 1 << (dateTimeOfYmd(dateYmd, tz).weekday % 7);
  for (const r of rows) {
    if (dateYmd < r.start || dateYmd > r.end) continue;
    if ((r.days & bit) !== 0) out.add(r.serviceId);
  }
  return out;
}

/**
 * The first date on or after `from` on which `serviceId` actually runs, as
 * YYYYMMDD, or `null` if it never does again inside its own calendar range.
 *
 * A GTFS trip's timetable is a set of offsets, not an instant: it carries no
 * date at all, and the same trip runs on every date its service is active.
 * So rendering `/trips/:tripId`'s times as ISO timestamps requires CHOOSING a
 * service date, and the only choice defensible without asking the caller is
 * the next one the trip genuinely runs — a date on which the rendered times
 * are the times a rider would actually experience, DST offset included.
 * Rendering against "today" regardless would produce timestamps for a day
 * the trip does not operate, which is worse than useless on a feed where
 * most services skip Saturdays.
 *
 * Bounded by the service's own `end` date and, defensively, by
 * MAX_LOOKAHEAD_DAYS, so a malformed row (`days` = 0 with a decade-long
 * range) cannot turn this into a long scan.
 */
const MAX_LOOKAHEAD_DAYS = 400;

export function nextServiceDate(
  rows: readonly CalendarRow[], serviceId: string, from: Date, tz: string,
): number | null {
  const row = rows.find((r) => r.serviceId === serviceId);
  // `days` of 0 is a service that runs on no weekday at all: it never
  // becomes active, so no amount of scanning forward would find a date.
  if (row === undefined || row.days === 0) return null;

  const fromYmd = ymdOf(from, tz);
  let day = dateTimeOfYmd(Math.max(fromYmd, row.start), tz);
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    const ymd = day.year * 10000 + day.month * 100 + day.day;
    if (ymd > row.end) return null;
    // Luxon weekday 1 = Monday .. 7 = Sunday; the feed's bitmask is
    // 0 = Sunday .. 6 = Saturday, so Sunday (7) maps to bit 0 — the same
    // mapping `activeServiceIds` uses.
    if ((row.days & (1 << (day.weekday % 7))) !== 0) return ymd;
    day = day.plus({ days: 1 });
  }
  return null;
}

/**
 * A service day's own time origin (noon − 12 h), for a date given as
 * YYYYMMDD rather than as a query instant. Same GTFS-spec definition
 * `serviceInstants` uses, exposed for callers that already know the date —
 * `/trips/:tripId` rendering a timetable against a chosen service date.
 */
export function baseEpochOfYmd(dateYmd: number, tz: string): number {
  return baseEpochOf(dateTimeOfYmd(dateYmd, tz));
}

export interface ServiceInstant {
  dateYmd: number;
  /** How far into this service day the query instant falls. May exceed 86400. */
  secondsSinceMidnight: number;
  /** Epoch seconds of this service day's time origin (noon − 12 h). */
  baseEpoch: number;
}

/**
 * GTFS defines a time as an offset from *noon minus 12 hours* on the service
 * date, not from midnight. The distinction matters exactly twice a year: on a
 * DST transition day, midnight-based arithmetic shifts every time after the
 * transition by an hour, while noon-based arithmetic does not. Asia/Jerusalem
 * observes DST, so this uses the spec's definition.
 */
function baseEpochOf(day: DateTime): number {
  const noon = day.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  return noon.toSeconds() - 12 * 3600;
}

export function ymdOf(at: Date, tz: string): number {
  const d = DateTime.fromJSDate(at, { zone: tz });
  return d.year * 10000 + d.month * 100 + d.day;
}

/**
 * The current service day *and* the previous one, because a trip that departed
 * yesterday at 25:30 is still running at 01:30 today. Every query must consider
 * both; returning them here means no call site can forget.
 *
 * Ordered current-day first, so a caller preferring the nearer day can take
 * the first match.
 */
export function serviceInstants(at: Date, tz: string): ServiceInstant[] {
  const now = DateTime.fromJSDate(at, { zone: tz });
  const epoch = now.toSeconds();

  const build = (day: DateTime): ServiceInstant => {
    const baseEpoch = baseEpochOf(day);
    return {
      dateYmd: day.year * 10000 + day.month * 100 + day.day,
      secondsSinceMidnight: Math.round(epoch - baseEpoch),
      baseEpoch,
    };
  };

  return [build(now), build(now.minus({ days: 1 }))];
}

export function toEpochSeconds(base: ServiceInstant, gtfsSeconds: number): number {
  return base.baseEpoch + gtfsSeconds;
}

export function toIso(epochSeconds: number, tz: string): string {
  // `suppressMilliseconds` keeps the wire format as 2026-08-24T08:14:00+03:00.
  return DateTime.fromSeconds(epochSeconds, { zone: tz })
    .toISO({ suppressMilliseconds: true }) ?? "";
}
