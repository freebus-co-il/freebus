import type Database from "better-sqlite3";
import type { Lang, Translator } from "./i18n.js";
import { lineDirectionOf, lineKeyOf } from "./lineKey.js";
import type { RouteBrief } from "./stops.js";
import { railDestinationSql, tripHeadsignOf } from "./tripHeadsign.js";
import {
  type CalendarRow, activeServiceIds, baseEpochOfYmd, serviceInstants, toEpochSeconds,
  toIso, ymdOf,
} from "../transit/calendar.js";

export interface Departure {
  tripId: string;
  stopId: string;
  stopSequence: number;
  /** ISO-8601 with offset. */
  departureTime: string;
  /**
   * ISO-8601 with offset: the SCHEDULED arrival at this exact `stop_times`
   * row -- distinct from `departureTime` only when the trip dwells at this
   * stop. Internal to this module's own callers: `routes/departures.ts`
   * uses it to anchor SIRI's arrival-shaped prediction (see
   * `RealtimeCall.expectedArrival`) back onto a derived departure
   * prediction via this stop's own dwell, the same derivation
   * `routes/plan.ts`'s `realtimeForLeg` does for a transit leg's board
   * stop. Not itself part of the public departures-board contract --
   * `routes/departures.ts` must not spread this field into a response.
   */
  arrivalTime: string;
  /** Where the trip is going: a rail trip's last stop, see `tripHeadsign.ts`. */
  headsign: string | null;
  /** The train number for a rail trip, null otherwise. */
  tripNumber: string | null;
  directionId: number;
  /** The line this run belongs to, as `GET /lines/:lineCode` names it -- so a
   *  board entry can open its line without a lookup of its own. */
  lineCode: string;
  /** Which of that line's directions: `route_desc`'s digit, the key the line
   *  page's direction toggle is keyed on. */
  lineDirection: string;
  route: RouteBrief;
}

/**
 * One departure with the ABSOLUTE INSTANT it happens at, before that instant
 * is rendered to a string. Merging two service days requires ordering by
 * this epoch; see the sort at the end of `departuresAt`.
 */
type Pending = Omit<Departure, "departureTime" | "arrivalTime"> & {
  epoch: number;
  /** The same absolute instant as `epoch`, but for the row's scheduled
   *  arrival rather than its departure -- see `Departure.arrivalTime`. */
  arrivalEpoch: number;
};

interface Row {
  departure_time: number; arrival_time: number; stop_sequence: number; stop_id: string;
  trip_id: string; service_id: string; trip_headsign: string | null;
  rail_destination: string | null;
  direction_id: number | null;
  route_id: string; agency_id: string | null; route_desc: string | null;
  route_short_name: string | null; route_long_name: string | null;
  route_type: number | null; route_color: string | null;
}

export function departuresAt(
  db: Database.Database,
  tr: Translator,
  calendar: readonly CalendarRow[],
  opts: {
    stopIds: string[]; at: Date; windowSeconds: number;
    limit: number; lang: Lang; tz: string;
    /** Restrict to one route. Used by `/routes/:routeId/trips`, which needs
     *  this line's runs from a stop that many other lines also serve. */
    routeId?: string;
  },
): Departure[] {
  if (opts.stopIds.length === 0) return [];
  const placeholders = opts.stopIds.map(() => "?").join(",");

  // ix_stop_times_stop_dep covers (stop_ref, departure_time), so this is an
  // index range scan per stop. pickup_type = 1 means boarding is not possible
  // (a trip's final stop) and must not appear on a departure board.
  // The filter is on `t.route_id` rather than `r.route_id` so it can use
  // ix_trips_route.
  const routeClause = opts.routeId === undefined ? "" : "AND t.route_id = ?";
  const stmt = db.prepare(`
    SELECT st.departure_time, st.arrival_time, st.stop_sequence, s.stop_id,
           t.trip_id, t.service_id, t.trip_headsign, t.direction_id,
           r.route_id, r.agency_id, r.route_short_name, r.route_long_name,
           r.route_type, r.route_color, r.route_desc,
           ${railDestinationSql("t.trip_ref", "r.route_type")} AS rail_destination
    FROM stop_times st
    JOIN stops  s ON s.stop_ref = st.stop_ref
    JOIN trips  t ON t.trip_ref = st.trip_ref
    JOIN routes r ON r.route_id = t.route_id
    WHERE s.stop_id IN (${placeholders})
      AND st.departure_time >= ? AND st.departure_time <= ?
      AND COALESCE(st.pickup_type, 0) <> 1
      ${routeClause}
    ORDER BY st.departure_time
  `);

  const out: Pending[] = [];

  // Both the current service day and the previous one: a trip that departed
  // yesterday at 25:30 is still running at 01:30 today.
  for (const instant of serviceInstants(opts.at, opts.tz)) {
    const active = activeServiceIds(calendar, instant.dateYmd, opts.tz);
    if (active.size === 0) continue;

    const from = instant.secondsSinceMidnight;
    const to = from + opts.windowSeconds;
    const rows = (opts.routeId === undefined
      ? stmt.all(...opts.stopIds, from, to)
      : stmt.all(...opts.stopIds, from, to, opts.routeId)) as Row[];

    for (const row of rows) {
      // Filtered here rather than in SQL: ~12,685 services are active on a
      // typical day, and a 12k-placeholder IN list cannot be prepared once
      // and reused. The window returns only a few hundred rows anyway.
      if (!active.has(row.service_id)) continue;
      out.push({
        tripId: row.trip_id,
        stopId: row.stop_id,
        stopSequence: row.stop_sequence,
        epoch: toEpochSeconds(instant, row.departure_time),
        arrivalEpoch: toEpochSeconds(instant, row.arrival_time),
        ...tripHeadsignOf(tr, opts.lang, row),
        directionId: row.direction_id ?? 0,
        lineCode: lineKeyOf(row.route_id, row.route_desc),
        lineDirection: lineDirectionOf(row.route_desc),
        route: {
          routeId: row.route_id,
          agencyId: row.agency_id,
          shortName: row.route_short_name,
          longName: row.route_long_name,
          type: row.route_type ?? 3,
          color: row.route_color === "" ? null : row.route_color,
        },
      });
    }
  }

  // Merged across two service days, so a final sort on absolute time is
  // required — the per-day queries are each ordered, but not against each other.
  //
  // ON THE EPOCH, NOT ON THE RENDERED STRING. The two service days being
  // merged here do not always carry the same UTC offset: across Israel's
  // autumn fall-back (2026-10-25, +03:00 -> +02:00) a 25:30 departure from
  // the 24th renders as `2026-10-25T01:30:00+03:00` while a 01:10 departure
  // from the 25th renders as `2026-10-25T01:10:00+02:00`. Lexicographically
  // the second sorts first; by epoch the FIRST is 40 minutes earlier, and
  // epoch is the truth — the offsets differ, so the local-time digits are
  // not comparable at all. Sorting the strings inverted the board for those
  // rows, and `limit` then truncated the wrong departures. It happens
  // annually. ISO is rendered only after this sort and the slice, so the
  // format is a presentation detail that no ordering depends on.
  out.sort((a, b) => a.epoch - b.epoch);
  return out.slice(0, opts.limit).map((d) => ({
    tripId: d.tripId,
    stopId: d.stopId,
    stopSequence: d.stopSequence,
    departureTime: toIso(d.epoch, opts.tz),
    arrivalTime: toIso(d.arrivalEpoch, opts.tz),
    headsign: d.headsign,
    tripNumber: d.tripNumber,
    directionId: d.directionId,
    lineCode: d.lineCode,
    lineDirection: d.lineDirection,
    route: d.route,
  }));
}

/**
 * How far past `at` each probe in `nextDepartureAfter` looks. Longer than a
 * day on purpose: stepping a whole 24h at a time would leave a gap wherever
 * a step lands either side of a DST change, and this feed's service days run
 * past midnight anyway (its latest departure is 29:23). The 2h of overlap
 * between consecutive probes is re-scanned, never re-reported -- each probe
 * filters to departures at or after its own start.
 */
const LOOKAHEAD_WINDOW_SECONDS = 26 * 60 * 60;

/** Days of lookahead before giving up. A stop with nothing in eight days is
 *  seasonal or withdrawn, not "closed today", and reporting a date that far
 *  out helps nobody. */
const LOOKAHEAD_MAX_DAYS = 8;

/**
 * The next departure from a stop at ANY point in the future, not just inside
 * a board's window.
 *
 * Exists for the honest empty board. Most of this feed does not run on
 * Shabbat, so "no departures in the next 60 minutes" is the answer a rider
 * gets for roughly a day a week -- true, and useless, because the real
 * question underneath it is "is this stop dead, or is the country just
 * closed right now?". One departure answers it.
 *
 * Steps forward a day at a time rather than widening a single query: the
 * per-day service lookup is what makes a departure real (see `departuresAt`),
 * so the scan has to be per-day too. Called only when a board comes back
 * empty, which is exactly when there is no work to compete with.
 */
export function nextDepartureAfter(
  db: Database.Database,
  tr: Translator,
  calendar: readonly CalendarRow[],
  opts: { stopIds: string[]; at: Date; lang: Lang; tz: string },
): Departure | null {
  for (let day = 0; day < LOOKAHEAD_MAX_DAYS; day += 1) {
    // Every probe past the first starts at its day's LOCAL MIDNIGHT, not at
    // the same clock time as `at`. A departure belongs to a service day (see
    // `departuresAt`), and `serviceInstants` only ever yields the day a
    // moment falls in and the one before -- so widening the window cannot
    // reach into tomorrow, and carrying the time of day forward would step
    // straight over every departure earlier than it. Asking about Saturday
    // at 10:00 and wanting Sunday's 08:00 bus is precisely that case.
    const at = day === 0
      ? opts.at
      : new Date(baseEpochOfYmd(
        ymdOf(new Date(opts.at.getTime() + day * 24 * 60 * 60 * 1000), opts.tz), opts.tz,
      ) * 1000);
    const [first] = departuresAt(db, tr, calendar, {
      stopIds: opts.stopIds, at,
      windowSeconds: LOOKAHEAD_WINDOW_SECONDS, limit: 1,
      lang: opts.lang, tz: opts.tz,
    });
    if (first !== undefined) return first;
  }
  return null;
}

/** One trip's boardable visit to one stop, with the fields a board row needs. */
export interface TripStopVisit {
  stopSequence: number;
  /** Raw GTFS seconds after the service day's origin. */
  arrivalSeconds: number;
  departureSeconds: number;
  /** See `Departure.headsign`. */
  headsign: string | null;
  /** See `Departure.tripNumber`. */
  tripNumber: string | null;
  directionId: number;
  lineCode: string;
  lineDirection: string;
  route: RouteBrief;
}

/**
 * `tripId`'s first boardable visit to `stopId`, or null. Used to build a row
 * for an unscheduled run from its template trip -- same route, headsign and
 * stop sequence -- whose times the caller then shifts. A final stop
 * (pickup_type 1) is not a departure, exactly as in `departuresAt`.
 */
export function tripStopVisit(
  db: Database.Database, tr: Translator, tripId: string, stopId: string, lang: Lang,
): TripStopVisit | null {
  const row = db.prepare(`
    SELECT st.stop_sequence, st.arrival_time, st.departure_time,
           t.trip_headsign, t.direction_id,
           r.route_id, r.agency_id, r.route_short_name, r.route_long_name, r.route_type,
           r.route_color, r.route_desc,
           ${railDestinationSql("t.trip_ref", "r.route_type")} AS rail_destination
    FROM trips t
    JOIN stop_times st ON st.trip_ref = t.trip_ref
    JOIN stops s ON s.stop_ref = st.stop_ref
    JOIN routes r ON r.route_id = t.route_id
    WHERE t.trip_id = ? AND s.stop_id = ? AND COALESCE(st.pickup_type, 0) <> 1
    ORDER BY st.stop_sequence
    LIMIT 1
  `).get(tripId, stopId) as {
    stop_sequence: number; arrival_time: number; departure_time: number;
    trip_headsign: string | null; direction_id: number | null;
    route_id: string; agency_id: string | null; route_short_name: string | null;
    route_long_name: string | null; route_type: number | null; route_color: string | null;
    route_desc: string | null; rail_destination: string | null;
  } | undefined;
  if (row === undefined) return null;
  return {
    stopSequence: row.stop_sequence,
    arrivalSeconds: row.arrival_time,
    departureSeconds: row.departure_time,
    ...tripHeadsignOf(tr, lang, row),
    directionId: row.direction_id ?? 0,
    lineCode: lineKeyOf(row.route_id, row.route_desc),
    lineDirection: lineDirectionOf(row.route_desc),
    route: {
      routeId: row.route_id,
      agencyId: row.agency_id,
      shortName: row.route_short_name,
      longName: row.route_long_name,
      type: row.route_type ?? 3,
      color: row.route_color === "" ? null : row.route_color,
    },
  };
}
