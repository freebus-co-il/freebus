import type Database from "better-sqlite3";
import { lineDirectionOf } from "./lineKey.js";
import type { Lang, Translator } from "./i18n.js";
import type { StopSummary, RouteBrief } from "./stops.js";
import { decodePolyline } from "../geo.js";
import { defaultRailGeometry, type RailGeometry } from "../rail/railGeometry.js";
import { departuresAt } from "./departures.js";
import { RAIL_ROUTE_TYPE } from "../transit/routeTypes.js";
import { railDestinationSql, tripHeadsignOf } from "./tripHeadsign.js";
import {
  type CalendarRow, baseEpochOfYmd, nextServiceDate, toIso, ymdOf,
} from "../transit/calendar.js";

export interface GeoJsonLineString {
  type: "LineString";
  /** GeoJSON order is [longitude, latitude]. */
  coordinates: [number, number][];
}

export interface RouteDirection {
  directionId: number;
  /** For rail, the representative trip's last stop -- see `directionHeadsign`. */
  headsign: string | null;
  shapeId: string | null;
  stops: StopSummary[];
}

export interface RouteDetail extends RouteBrief {
  desc: string | null;
  directions: RouteDirection[];
}

export interface TripStopTime {
  stop: StopSummary;
  stopSequence: number;
  /**
   * Raw GTFS seconds after the service day's origin. Legitimately exceeds
   * 86400 for late-night service (the live feed's maximum is 105787, i.e.
   * 29:23:07) and is never clamped or wrapped.
   *
   * `/trips/:tripId` is the ONE endpoint that exposes these, and does so
   * deliberately: a trip's timetable is the schedule itself, not an instance
   * of it, and a client editing, diffing or re-exporting GTFS needs the
   * value the feed actually contains. Everywhere else in this API, times are
   * ISO-8601 only.
   */
  arrivalSeconds: number | null;
  /** Raw GTFS seconds after the service day's origin. See `arrivalSeconds`. */
  departureSeconds: number | null;
  /**
   * The same time rendered as ISO-8601 with offset, against `serviceDate`
   * (see `TripDetail.serviceDate` for which date that is and why). `null`
   * when the raw value is null, or when the trip's service has no remaining
   * active date to render against.
   */
  arrivalTime: string | null;
  /** See `arrivalTime`. */
  departureTime: string | null;
}

export interface TripDetail {
  tripId: string;
  route: RouteBrief;
  /** Where the trip is going: a rail trip's last stop, see `tripHeadsign.ts`. */
  headsign: string | null;
  /** The train number for a rail trip, null otherwise. */
  tripNumber: string | null;
  directionId: number;
  wheelchairAccessible: number | null;
  /**
   * The service date, YYYYMMDD, that every `arrivalTime`/`departureTime`
   * below was rendered against: the NEXT date on or after "now" on which
   * this trip's service actually runs.
   *
   * A GTFS trip carries no date — it is a set of offsets that repeats on
   * every date its `service_id` is active — so an ISO timestamp for it only
   * exists relative to a chosen date, and this field names the choice rather
   * than hiding it. "The next date it actually runs" is picked over "today"
   * because most services in this feed skip Saturdays: rendering against a
   * date the trip does not operate would produce times no rider could ever
   * experience, and would silently pick the wrong UTC offset either side of
   * a DST transition. `null` when the service has no remaining active date
   * inside its own calendar range, in which case every ISO field below is
   * `null` too and only the raw seconds are available.
   */
  serviceDate: number | null;
  stops: TripStopTime[];
  geometry: GeoJsonLineString | null;
  geometryFallback: boolean;
}

interface RouteRow {
  route_id: string; agency_id: string | null; route_short_name: string | null;
  route_long_name: string | null; route_desc: string | null;
  route_type: number | null; route_color: string | null;
}

function toBrief(r: RouteRow): RouteBrief {
  return {
    routeId: r.route_id,
    agencyId: r.agency_id,
    shortName: r.route_short_name,
    // route_long_name has no translations in this feed.
    longName: r.route_long_name,
    type: r.route_type ?? 3,
    color: r.route_color === "" ? null : r.route_color,
  };
}

/**
 * The ministry line code inside `route_desc`: the text before the first
 * `-`, or the whole value when there is none.
 *
 * `route_desc` is `<lineCode>-<direction>-<alternative>` for every bus row,
 * and a bare number for every rail row.
 *
 * This is the SORT key only -- see `LINE_KEY_SQL` for the identity key, and
 * why the two differ for rail. Sorting rail rows that share a bare desc
 * next to each other is harmless: adjacency is all the ordering owes the
 * client, and two rows of one desc are as adjacent as one is.
 *
 * MUST stay identical to `lineCodeOf` in the app's
 * `features/lines/group-routes.ts`. The two are one contract split across
 * the wire: if they disagree, the ordering this produces stops matching the
 * grouping the client does over it, and lines silently split in the list.
 */
export const LINE_CODE_SQL = `CASE WHEN instr(route_desc, '-') > 0
  THEN substr(route_desc, 1, instr(route_desc, '-') - 1)
  ELSE route_desc END`;

/**
 * The IDENTITY of a line: what `/lines/:lineCode` resolves and what
 * `?lineCode=` filters on. The ministry line code for a dashed `route_desc`
 * (every bus row), and `route:<route_id>` for an undashed one (every rail
 * row).
 *
 * Rail cannot be keyed on its desc. The 1,065 `route_type` 2 rows carry a
 * bare number there, and 32 of those numbers are carried by exactly TWO
 * route rows each -- genuinely different services, e.g. desc '1' is both
 * `38450` נהריה<->נתב"ג and `44031` נהריה<->מודיעין מרכז. Keying on the desc
 * merges the pair into one "line", and because `getLine` then buckets both
 * into a single direction and keeps only the most-stops representative, the
 * other service becomes unreachable. Rail carries no line identity in this
 * feed at all, so the route row IS the line, and its id is the only key
 * that distinguishes one from the other.
 *
 * The `route:` prefix keeps rail keys from ever colliding with a bus line
 * code, and survives a URL path segment unencoded (a colon is legal there).
 *
 * MUST stay identical to `lineKeyOf` in the app's
 * `features/lines/group-routes.ts`: the app groups rows into lines with it
 * and then navigates with the value it produced, so a divergence yields
 * rows whose line page 404s.
 */
export const LINE_KEY_SQL = `CASE WHEN instr(route_desc, '-') > 0
  THEN substr(route_desc, 1, instr(route_desc, '-') - 1)
  ELSE 'route:' || route_id END`;

/**
 * A route row as the browse list needs it: a brief plus the raw `desc` the
 * client groups on. `RouteBrief` is deliberately NOT widened -- it is shared
 * with departures, stops and plan responses, none of which group anything.
 */
export interface RouteListItem extends RouteBrief {
  desc: string | null;
}

/**
 * `n` bound placeholders for an `IN (...)` list.
 *
 * Only the COUNT ever reaches the SQL string; every value stays a bound
 * parameter. A list filter must never be built by interpolating its values,
 * however "obviously numeric" they were validated to be at the edge.
 */
function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/**
 * One page of route rows, ordered so that every row of a line is contiguous.
 *
 * `agency`, `type` and `excludeTypes` are LISTS: the Lines tab's operator
 * and vehicle-type chips are both multi-select, and a one-value-per-filter
 * API would force it into one request per selected chip and a client-side
 * merge that pagination cannot survive. A single-entry list is the old
 * single-value behaviour exactly, which is what makes this a widening.
 *
 * `excludeTypes` subtracts AFTER `type` selects, so the two can be sent
 * together and exclusion wins -- see the clause itself. Its `NOT IN` also
 * drops any row whose `route_type` is NULL (SQL's three-valued logic); no
 * row in the real feed has one, and `toBrief` would have called such a row
 * a bus anyway.
 *
 * `opts.lineCode` filters on `LINE_KEY_SQL` -- the ministry line code for a
 * bus row, `route:<route_id>` for a rail row -- and NOT on the
 * `LINE_CODE_SQL` the ordering uses. The two diverge for rail on purpose:
 * 32 bare rail descs are shared by two different services each, so the desc
 * groups rows for sorting but cannot name one of them. Passing a bare rail
 * desc here therefore matches nothing, which is correct: it is not the name
 * of any single line.
 */
export function listRoutes(
  db: Database.Database,
  opts: {
    agency?: readonly string[];
    type?: readonly number[];
    excludeTypes?: readonly number[];
    q?: string; lineCode?: string; limit: number; offset: number;
  },
): { routes: RouteListItem[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agency !== undefined && opts.agency.length > 0) {
    where.push(`agency_id IN (${placeholders(opts.agency.length)})`);
    params.push(...opts.agency);
  }
  if (opts.type !== undefined && opts.type.length > 0) {
    where.push(`route_type IN (${placeholders(opts.type.length)})`);
    params.push(...opts.type);
  }
  // After `type`, and as its own conjunct, so exclusion WINS: `type=2` with
  // `excludeTypes=2` is `route_type IN (2) AND route_type NOT IN (2)`, which
  // is empty. A rider who has asked twice, contradictorily, gets the
  // narrower answer rather than one of the two silently dropped.
  if (opts.excludeTypes !== undefined && opts.excludeTypes.length > 0) {
    where.push(`route_type NOT IN (${placeholders(opts.excludeTypes.length)})`);
    params.push(...opts.excludeTypes);
  }
  if (opts.lineCode !== undefined && opts.lineCode !== "") {
    // The identity key, not the sort key: a rail row answers to
    // `route:<route_id>` and never to the desc it shares with another
    // service. See `LINE_KEY_SQL`.
    where.push(`${LINE_KEY_SQL} = ?`); params.push(opts.lineCode);
  }
  if (opts.q !== undefined && opts.q !== "") {
    where.push("(route_short_name LIKE ? OR route_long_name LIKE ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM routes ${clause}`)
    .get(...params) as { n: number }).n;

  // Line code first, so both directions and every alternative of one line
  // are contiguous in the ordering. The app groups route rows into lines
  // across a paginated accumulator, and that only converges if a line's
  // rows cannot be scattered across the whole result. `route_id` sorts as
  // TEXT, so it does not provide this on its own: "1", "10379" and "1064"
  // interleave lines that have nothing to do with each other.
  const rows = db.prepare(`
    SELECT route_id, agency_id, route_short_name, route_long_name, route_desc,
           route_type, route_color
    FROM routes ${clause}
    ORDER BY ${LINE_CODE_SQL}, CAST(route_short_name AS INTEGER),
             route_short_name, route_id
    LIMIT ? OFFSET ?
  `).all(...params, opts.limit, opts.offset) as RouteRow[];

  return {
    routes: rows.map((r) => ({ ...toBrief(r), desc: r.route_desc })),
    total,
  };
}

/**
 * The trip whose stop sequence best represents a direction: the one with the
 * most stops. A line's short workings (a few trips that turn back early)
 * would otherwise be an arbitrary and misleading choice of "the" stop list.
 */
function representativeTrip(
  db: Database.Database, routeId: string, directionId: number,
): { trip_ref: number; trip_headsign: string | null; shape_id: string | null } | undefined {
  return db.prepare(`
    SELECT t.trip_ref, t.trip_headsign, t.shape_id
    FROM trips t
    WHERE t.route_id = ? AND COALESCE(t.direction_id, 0) = ?
    ORDER BY (SELECT COUNT(*) FROM stop_times st WHERE st.trip_ref = t.trip_ref) DESC
    LIMIT 1
  `).get(routeId, directionId) as
    { trip_ref: number; trip_headsign: string | null; shape_id: string | null } | undefined;
}

/**
 * A direction's headsign and stop list. A direction is not one train, so it
 * carries no train number; for rail its headsign is the representative trip's
 * last stop, because the feed's rail `trip_headsign` is a train number (see
 * `tripHeadsign.ts`). `stops` is already translated and ordered by
 * stop_sequence, so its last entry is that destination.
 */
function directionOf(
  routeType: number | null, trip: { trip_headsign: string | null }, stops: StopSummary[],
  tr: Translator, lang: Lang,
): { headsign: string | null; stops: StopSummary[] } {
  return {
    headsign: routeType === RAIL_ROUTE_TYPE
      ? stops[stops.length - 1]?.name ?? null
      : tr.resolve(trip.trip_headsign, lang),
    stops,
  };
}

function stopsOfTrip(
  db: Database.Database, tripRef: number, tr: Translator, lang: Lang,
): StopSummary[] {
  const rows = db.prepare(`
    SELECT s.stop_id, s.stop_code, s.stop_name, s.stop_lat, s.stop_lon,
           s.location_type, s.parent_station
    FROM stop_times st JOIN stops s ON s.stop_ref = st.stop_ref
    WHERE st.trip_ref = ? ORDER BY st.stop_sequence
  `).all(tripRef) as {
    stop_id: string; stop_code: string | null; stop_name: string | null;
    stop_lat: number; stop_lon: number;
    location_type: number | null; parent_station: string | null;
  }[];
  return rows.map((r) => ({
    stopId: r.stop_id,
    code: r.stop_code,
    name: tr.resolve(r.stop_name, lang),
    lat: r.stop_lat,
    lon: r.stop_lon,
    locationType: r.location_type ?? 0,
    parentStation: r.parent_station === "" ? null : r.parent_station,
  }));
}

export function getRoute(
  db: Database.Database, tr: Translator, routeId: string, lang: Lang,
): RouteDetail | null {
  const row = db.prepare(`
    SELECT route_id, agency_id, route_short_name, route_long_name, route_desc,
           route_type, route_color FROM routes WHERE route_id = ?
  `).get(routeId) as RouteRow | undefined;
  if (row === undefined) return null;

  const dirRows = db.prepare(
    "SELECT DISTINCT COALESCE(direction_id, 0) AS d FROM trips WHERE route_id = ? ORDER BY d",
  ).all(routeId) as { d: number }[];

  const directions: RouteDirection[] = [];
  for (const { d } of dirRows) {
    const trip = representativeTrip(db, routeId, d);
    if (trip === undefined) continue;
    directions.push({
      directionId: d,
      ...directionOf(row.route_type, trip, stopsOfTrip(db, trip.trip_ref, tr, lang), tr, lang),
      shapeId: trip.shape_id === "" ? null : trip.shape_id,
    });
  }

  return { ...toBrief(row), desc: row.route_desc, directions };
}

function lineStringFrom(points: readonly (readonly [number, number])[]): GeoJsonLineString {
  // decodePolyline yields [lat, lon]; GeoJSON demands [lon, lat].
  return { type: "LineString", coordinates: points.map(([lat, lon]) => [lon, lat]) };
}

export function getRouteShape(
  db: Database.Database, routeId: string, directionId: number,
  rail: RailGeometry = defaultRailGeometry(),
): { geometry: GeoJsonLineString; geometryFallback: boolean } | null {
  const trip = representativeTrip(db, routeId, directionId);
  if (trip === undefined) return null;

  const shapeId = trip.shape_id === "" ? null : trip.shape_id;
  if (shapeId !== null) {
    const shape = db.prepare("SELECT encoded_polyline FROM shapes WHERE shape_id = ?")
      .get(shapeId) as { encoded_polyline: string } | undefined;
    if (shape !== undefined) {
      return { geometry: lineStringFrom(decodePolyline(shape.encoded_polyline)), geometryFallback: false };
    }
  }

  // Every rail trip in the real feed has no shape. Rail is drawn along its
  // baked OpenStreetMap track (rail/railGeometry.ts), which is real geometry.
  const pts = db.prepare(`
    SELECT s.stop_id AS stopId, s.stop_lat AS lat, s.stop_lon AS lon
    FROM stop_times st JOIN stops s ON s.stop_ref = st.stop_ref
    WHERE st.trip_ref = ? ORDER BY st.stop_sequence
  `).all(trip.trip_ref) as { stopId: string; lat: number; lon: number }[];

  const routeType = db.prepare("SELECT route_type FROM routes WHERE route_id = ?")
    .get(routeId) as { route_type: number | null } | undefined;
  const track = routeType?.route_type === RAIL_ROUTE_TYPE ? rail.lineThrough(pts) : null;
  if (track !== null) return { geometry: lineStringFrom(track), geometryFallback: false };

  // Otherwise draw the stop-to-stop line and flag it, so a client can style
  // it differently rather than believing it has real geometry.
  return {
    geometry: lineStringFrom(pts.map((p) => [p.lat, p.lon] as const)),
    geometryFallback: true,
  };
}

export function getTrip(
  db: Database.Database, tr: Translator, tripId: string, lang: Lang,
  opts: { calendar: readonly CalendarRow[]; tz: string; now?: Date; rail?: RailGeometry },
): TripDetail | null {
  const trip = db.prepare(`
    SELECT trip_ref, trip_id, route_id, service_id, trip_headsign, direction_id,
           shape_id, wheelchair_accessible FROM trips WHERE trip_id = ?
  `).get(tripId) as {
    trip_ref: number; trip_id: string; route_id: string | null;
    service_id: string | null;
    trip_headsign: string | null; direction_id: number | null;
    shape_id: string | null; wheelchair_accessible: number | null;
  } | undefined;
  if (trip === undefined) return null;

  const routeRow = db.prepare(`
    SELECT route_id, agency_id, route_short_name, route_long_name, route_desc,
           route_type, route_color FROM routes WHERE route_id = ?
  `).get(trip.route_id) as RouteRow | undefined;

  const times = db.prepare(`
    SELECT st.stop_sequence, st.arrival_time, st.departure_time,
           s.stop_id, s.stop_code, s.stop_name, s.stop_lat, s.stop_lon,
           s.location_type, s.parent_station
    FROM stop_times st JOIN stops s ON s.stop_ref = st.stop_ref
    WHERE st.trip_ref = ? ORDER BY st.stop_sequence
  `).all(trip.trip_ref) as {
    stop_sequence: number; arrival_time: number | null; departure_time: number | null;
    stop_id: string; stop_code: string | null; stop_name: string | null;
    stop_lat: number; stop_lon: number;
    location_type: number | null; parent_station: string | null;
  }[];

  const shapeId = trip.shape_id === "" ? null : trip.shape_id;
  const shape = shapeId === null ? undefined
    : db.prepare("SELECT encoded_polyline FROM shapes WHERE shape_id = ?")
        .get(shapeId) as { encoded_polyline: string } | undefined;

  // No shape is every rail trip: drawn along its baked track when there is one.
  const track = shape === undefined && routeRow?.route_type === RAIL_ROUTE_TYPE
    ? (opts.rail ?? defaultRailGeometry()).lineThrough(
      times.map((t) => ({ stopId: t.stop_id, lat: t.stop_lat, lon: t.stop_lon })),
    )
    : null;

  const geometry = shape !== undefined
    ? lineStringFrom(decodePolyline(shape.encoded_polyline))
    : lineStringFrom(track ?? times.map((t) => [t.stop_lat, t.stop_lon] as const));

  // The date every ISO time below is rendered against. Resolved ONCE per
  // trip, not per stop time, so a trip whose stop times straddle midnight
  // (a 25:30 departure) still renders as one continuous timetable on one
  // service day rather than jumping back a day mid-list -- which is exactly
  // what the raw seconds already encode and what
  // `baseEpochOfYmd(...) + rawSeconds` reproduces.
  const serviceDate = trip.service_id === null ? null
    : nextServiceDate(opts.calendar, trip.service_id, opts.now ?? new Date(), opts.tz);
  const baseEpoch = serviceDate === null ? null : baseEpochOfYmd(serviceDate, opts.tz);
  const iso = (seconds: number | null): string | null =>
    seconds === null || baseEpoch === null ? null : toIso(baseEpoch + seconds, opts.tz);

  return {
    tripId: trip.trip_id,
    route: routeRow !== undefined ? toBrief(routeRow)
      : {
        routeId: trip.route_id ?? "", agencyId: null, shortName: null,
        longName: null, type: 3, color: null,
      },
    // `times` is ordered by stop_sequence, so its last row IS the rail
    // destination -- no extra query, unlike the SQL surfaces.
    ...tripHeadsignOf(tr, lang, {
      trip_headsign: trip.trip_headsign,
      route_type: routeRow?.route_type ?? null,
      rail_destination: times[times.length - 1]?.stop_name ?? null,
    }),
    directionId: trip.direction_id ?? 0,
    wheelchairAccessible: trip.wheelchair_accessible,
    serviceDate,
    stops: times.map((t) => ({
      stop: {
        stopId: t.stop_id, code: t.stop_code, name: tr.resolve(t.stop_name, lang),
        lat: t.stop_lat, lon: t.stop_lon,
        locationType: t.location_type ?? 0,
        parentStation: t.parent_station === "" ? null : t.parent_station,
      },
      stopSequence: t.stop_sequence,
      // Raw GTFS seconds, never clamped: values above 86400 are real.
      arrivalSeconds: t.arrival_time,
      departureSeconds: t.departure_time,
      // ...and the same instants as ISO, so this endpoint satisfies the
      // API-wide "ISO everywhere" rule without dropping the raw schedule
      // values a GTFS-aware client came here for.
      arrivalTime: iso(t.arrival_time),
      departureTime: iso(t.departure_time),
    })),
    geometry,
    geometryFallback: shape === undefined && track === null,
  };
}

/** One run of a line: enough to label a chip and open the trip. */
export interface RouteRun {
  tripId: string;
  /** The run's identity: `tripId` for a timetable run; see `runIdFor` for an
   *  unscheduled one, which shares its template's `tripId`. */
  runId: string;
  /** True for a live bus running off-timetable on `tripId`'s slot. */
  unscheduled: boolean;
  /** Seconds to add to `tripId`'s own stop times to get this run's: 0 for a
   *  timetable run. */
  offsetSeconds: number;
  /** See `Departure.headsign`. */
  headsign: string | null;
  /** See `Departure.tripNumber`. */
  tripNumber: string | null;
  /** ISO-8601 with offset, departing this route's first stop -- or, from
   *  `runsAround`, departing the stop the runs were asked around. */
  departureTime: string;
  directionId: number;
}

/**
 * How many days `nextRuns` will probe before giving up. A week, because most
 * of this feed does not run on Shabbat: stopping at "today" would return an
 * empty run list for every line in the country for roughly a day in seven,
 * and the line page would have no times to render precisely when a rider is
 * most likely to be planning ahead.
 */
const RUNS_LOOKAHEAD_DAYS = 7;

/**
 * How far each per-day probe looks. Longer than a day on purpose, exactly as
 * `nextDepartureAfter`'s own lookahead is: stepping a flat 24h would leave a
 * gap wherever a step lands either side of a DST change, and this feed's
 * service days run past midnight anyway (its latest departure is 29:23).
 */
const RUNS_PROBE_SECONDS = 26 * 60 * 60;

/**
 * The next runs of one route, as departures from its own first stop.
 *
 * Built on `departuresAt` rather than a fresh query on purpose: service-day
 * resolution, past-midnight departures (this feed reaches 29:23) and the
 * epoch-not-string ordering across a DST boundary are all solved there and
 * all subtly wrong when re-derived. The `routeId` filter added for this is
 * what makes it usable from a first stop that a dozen other lines also
 * serve.
 *
 * The lookahead is a LOOP of per-day probes, not one wide `windowSeconds`.
 * Widening a single call cannot reach tomorrow: `serviceInstants` only ever
 * yields the day the query instant falls in and the one before, and
 * `windowSeconds` is measured in seconds-since-midnight *within* those days,
 * so anything past the end of today's service day simply matches no
 * `stop_times` row. Every probe past the first therefore starts at its day's
 * LOCAL MIDNIGHT rather than carrying `now`'s time of day forward, which
 * would step over each following morning's departures -- the same reasoning,
 * and the same shape, as `nextDepartureAfter`.
 *
 * The FIRST day that has any run wins, and the loop stops there rather than
 * topping the list up from the day after. A `RouteRun` carries a departure
 * instant and no date, so a list that spilled across days would render as
 * the same handful of trips repeated at the same clock times, with nothing
 * on screen to say which day each belongs to. "The rest of this line's
 * service day" is the answer the line page can actually draw.
 */
export function nextRuns(
  db: Database.Database,
  tr: Translator,
  calendar: readonly CalendarRow[],
  opts: { routeId: string; limit: number; lang: Lang; tz: string; now?: Date },
): RouteRun[] {
  // The route's own first stop: the representative trip's stop_sequence 1.
  // A run is labelled by when it STARTS, not by when it reaches some
  // arbitrary stop partway along.
  const trip = representativeTrip(db, opts.routeId, 0)
    ?? representativeTrip(db, opts.routeId, 1);
  if (trip === undefined) return [];

  const first = db.prepare(`
    SELECT s.stop_id FROM stop_times st JOIN stops s ON s.stop_ref = st.stop_ref
    WHERE st.trip_ref = ? ORDER BY st.stop_sequence LIMIT 1
  `).get(trip.trip_ref) as { stop_id: string } | undefined;
  if (first === undefined) return [];

  const now = opts.now ?? new Date();

  for (let day = 0; day < RUNS_LOOKAHEAD_DAYS; day += 1) {
    const at = day === 0
      ? now
      : new Date(baseEpochOfYmd(
        ymdOf(new Date(now.getTime() + day * 24 * 60 * 60 * 1000), opts.tz), opts.tz,
      ) * 1000);

    const departures = departuresAt(db, tr, calendar, {
      stopIds: [first.stop_id],
      at,
      windowSeconds: RUNS_PROBE_SECONDS,
      limit: opts.limit,
      lang: opts.lang,
      tz: opts.tz,
      routeId: opts.routeId,
    });
    if (departures.length === 0) continue;

    return departures.map((d) => ({
      tripId: d.tripId,
      runId: d.tripId,
      unscheduled: false,
      offsetSeconds: 0,
      headsign: d.headsign,
      tripNumber: d.tripNumber,
      departureTime: d.departureTime,
      directionId: d.directionId,
    }));
  }

  return [];
}

/** A trip's headsign (translated), train number and direction, or null for an
 *  unknown id. */
export function tripBrief(
  db: Database.Database, tr: Translator, tripId: string, lang: Lang,
): { headsign: string | null; tripNumber: string | null; directionId: number } | null {
  const row = db.prepare(`
    SELECT t.trip_headsign, t.direction_id, r.route_type,
           ${railDestinationSql("t.trip_ref", "r.route_type")} AS rail_destination
    FROM trips t LEFT JOIN routes r ON r.route_id = t.route_id
    WHERE t.trip_id = ?
  `).get(tripId) as {
    trip_headsign: string | null; direction_id: number | null;
    route_type: number | null; rail_destination: string | null;
  } | undefined;
  if (row === undefined) return null;
  return { ...tripHeadsignOf(tr, lang, row), directionId: row.direction_id ?? 0 };
}

/** How far before now `runsAround` looks for the run ahead of the rider's.
 *  Two hours covers the widest headway a rider would still call "the bus
 *  before", and keeps the probe short enough that `departuresAt`'s limit --
 *  which drops the LATEST rows -- is never reached on a frequent line. */
const AROUND_LOOKBACK_SECONDS = 2 * 60 * 60;
/** The whole probe, lookback included: the rider's run is on a board that
 *  looks an hour ahead, and three more hours leaves room for the runs after. */
const AROUND_WINDOW_SECONDS = 5 * 60 * 60;
/** A bus line every two minutes fills five hours with 150 runs. */
const AROUND_LIMIT = 200;

/**
 * One run of a route and its neighbours at one stop: the run before it, the
 * run itself, and up to `after` runs behind it, timed at THAT stop.
 *
 * For a rider who tapped a departure on a station board: they are waiting
 * for this run, the one ahead of it may still be in sight, and the ones
 * behind it are what they fall back on. `nextRuns` cannot answer that -- it
 * times runs at the route's first stop and only from now, so the run ahead
 * has usually left that stop already.
 *
 * An empty list, never a guess, when the trip does not call at this stop
 * inside the probe -- a stale board entry, or an id from another route.
 */
export function runsAround(
  db: Database.Database,
  tr: Translator,
  calendar: readonly CalendarRow[],
  opts: {
    routeId: string; stopId: string; tripId: string; after: number;
    lang: Lang; tz: string; now?: Date;
  },
): RouteRun[] {
  const now = opts.now ?? new Date();
  const departures = departuresAt(db, tr, calendar, {
    stopIds: [opts.stopId],
    at: new Date(now.getTime() - AROUND_LOOKBACK_SECONDS * 1000),
    windowSeconds: AROUND_WINDOW_SECONDS,
    limit: AROUND_LIMIT,
    lang: opts.lang,
    tz: opts.tz,
    routeId: opts.routeId,
  });

  const index = departures.findIndex((d) => d.tripId === opts.tripId);
  if (index === -1) return [];
  return departures.slice(Math.max(0, index - 1), index + 1 + opts.after).map((d) => ({
    tripId: d.tripId,
    runId: d.tripId,
    unscheduled: false,
    offsetSeconds: 0,
    headsign: d.headsign,
    tripNumber: d.tripNumber,
    departureTime: d.departureTime,
    directionId: d.directionId,
  }));
}

/** One direction of a line, after alternatives have been collapsed. */
export interface LineDirection {
  /**
   * `route_desc`'s direction digit, and the ONLY correct key for a line's
   * directions. GTFS `direction_id` is not: across this feed, desc digit 1
   * maps to `direction_id` 0, digit 2 to 1, and digit 3 back to 0 -- so the
   * 22 three-direction lines have two distinct directions that both report
   * `direction_id` 0, and keying on it silently merges them.
   */
  direction: string;
  /** GTFS `direction_id`, carried only because `/routes/:routeId/shape` is
   *  parameterised by it. Never used as a key -- see `direction`. */
  directionId: number;
  /** The route row that represents this direction: of its alternatives, the
   *  one whose representative trip calls at the most stops. A line's short
   *  workings must not be mistaken for the line. */
  routeId: string;
  /** For rail, the representative trip's last stop -- see `directionHeadsign`. */
  headsign: string | null;
  stops: StopSummary[];
}

export interface LineDetail {
  lineCode: string;
  shortName: string | null;
  longName: string | null;
  agencyId: string | null;
  type: number;
  directions: LineDirection[];
}


/**
 * A whole public line, assembled from the several route rows that make it up.
 *
 * This feed has no "line" table: it stores one route row per direction per
 * alternative, so line 34001 is four rows and a naive direction toggle over
 * them offers "the same" direction three times. Collapsing them needs stop
 * counts, which is why this is server-side and not a client-side grouping
 * like the browse list's.
 *
 * `lineCode` is a `LINE_KEY_SQL` value: a ministry line code for bus, and
 * `route:<route_id>` for rail. Rail must NOT be looked up by its bare desc.
 * 32 of those descs are carried by two different services each, so a desc
 * lookup would collect both rows, bucket them into the single direction
 * `directionOf` gives an undashed desc, and then keep only the one with
 * more stops -- silently deleting the other service from the app. Keyed on
 * the route id, each rail row is its own one-direction line, which is what
 * the design intended.
 */
export function getLine(
  db: Database.Database, tr: Translator, lineCode: string, lang: Lang,
): LineDetail | null {
  const rows = db.prepare(`
    SELECT route_id, agency_id, route_short_name, route_long_name, route_desc,
           route_type, route_color
    FROM routes WHERE ${LINE_KEY_SQL} = ?
    ORDER BY route_id
  `).all(lineCode) as RouteRow[];
  if (rows.length === 0) return null;

  // Group the rows by their desc direction digit, then pick one per group.
  const byDirection = new Map<string, RouteRow[]>();
  for (const row of rows) {
    const d = lineDirectionOf(row.route_desc);
    const bucket = byDirection.get(d);
    if (bucket === undefined) byDirection.set(d, [row]);
    else bucket.push(row);
  }

  const directions: LineDirection[] = [];
  for (const direction of [...byDirection.keys()].sort()) {
    let best: { row: RouteRow; directionId: number; stops: StopSummary[]; headsign: string | null } | null = null;
    for (const row of byDirection.get(direction)!) {
      // A route row has trips in exactly one direction_id (verified across
      // the feed), so whichever of the two probes hits is that row's.
      for (const directionId of [0, 1]) {
        const trip = representativeTrip(db, row.route_id, directionId);
        if (trip === undefined) continue;
        const stops = stopsOfTrip(db, trip.trip_ref, tr, lang);
        if (best === null || stops.length > best.stops.length) {
          best = { row, directionId, ...directionOf(row.route_type, trip, stops, tr, lang) };
        }
      }
    }
    if (best === null) continue;
    directions.push({
      direction,
      directionId: best.directionId,
      routeId: best.row.route_id,
      headsign: best.headsign,
      stops: best.stops,
    });
  }

  // Any row carries the line's identity -- they differ only in direction.
  const first = rows[0]!;
  return {
    lineCode,
    shortName: first.route_short_name === "" ? null : first.route_short_name,
    longName: first.route_long_name,
    agencyId: first.agency_id,
    type: first.route_type ?? 3,
    directions,
  };
}
