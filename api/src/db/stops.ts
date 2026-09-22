import type Database from "better-sqlite3";
import type { Lang } from "./i18n.js";
import type { Translator } from "./i18n.js";
import { bboxAround, haversineMeters } from "../geo.js";
import { LIGHT_RAIL_ROUTE_TYPE, RAIL_ROUTE_TYPE } from "../transit/routeTypes.js";
import {
  CARMELIT_AGENCY_ID, METRONIT_LINE_CODES, stationKindOf, type SignRoute, type StationKind,
} from "../transit/stationKind.js";

export interface StopSummary {
  stopId: string;
  code: string | null;
  name: string | null;
  lat: number;
  lon: number;
  locationType: number;
  parentStation: string | null;
}

export interface RouteBrief {
  routeId: string;
  /**
   * The operating company, GTFS `agency_id`. Carried on every route brief
   * because the app colours a route by its operator: this feed's
   * `route_color` is the ministry's service-CLASS code (the same four values
   * recur across every company), so the operator is the only brand signal
   * the feed actually contains. `null` only if the feed omits it.
   */
  agencyId: string | null;
  shortName: string | null;
  longName: string | null;
  type: number;
  color: string | null;
}

export interface StopDetail extends StopSummary {
  desc: string | null;
  /** Which sign the stop shows -- see `stationKindAt`. */
  stationKind: StationKind;
  children: StopSummary[];
  routes: RouteBrief[];
}

interface StopRow {
  stop_ref: number; stop_id: string; stop_code: string | null;
  stop_name: string | null; stop_desc: string | null;
  stop_lat: number; stop_lon: number;
  location_type: number | null; parent_station: string | null;
}

const STOP_COLS = `stop_ref, stop_id, stop_code, stop_name, stop_desc,
  stop_lat, stop_lon, location_type, parent_station`;

function toSummary(row: StopRow, tr: Translator, lang: Lang): StopSummary {
  return {
    stopId: row.stop_id,
    code: row.stop_code,
    name: tr.resolve(row.stop_name, lang),
    lat: row.stop_lat,
    lon: row.stop_lon,
    locationType: row.location_type ?? 0,
    parentStation: row.parent_station === "" ? null : row.parent_station,
  };
}

/**
 * Builds an FTS5 MATCH expression that treats the user's input as literal
 * text. Every token is double-quoted (internal quotes doubled), so FTS5
 * operators the user happens to type — `OR`, `NEAR`, `*`, `"` — are matched
 * as words rather than executed as syntax. A prefix wildcard is appended to
 * the final token so search feels incremental as the user types.
 */
function ftsQuery(q: string): string {
  const tokens = q.trim().split(/\s+/).filter((t) => t.length > 0);
  const quoted = tokens
    // Strip C0 control characters and DEL before quoting. FTS5's query
    // parser reads an embedded NUL as premature string termination even
    // inside a quoted token, throwing a syntax error the caller can't
    // recover from — so this has to happen pre-quoting, not be replaced by
    // quoting. A control character in a search box is noise, not a client
    // error, so it is silently dropped rather than rejected.
    .map((t) => t.replace(/[\u0000-\u001f\u007f]/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (quoted.length === 0) return "";
  const last = quoted[quoted.length - 1];
  // Guaranteed present: `quoted` is non-empty per the check above.
  quoted[quoted.length - 1] = `${last!}*`;
  return quoted.join(" ");
}

/**
 * The lines that call at a stop, as much as a badge needs to draw one: the
 * number to print, the operator to colour it by, and the vehicle kind to
 * fall back to when the line has no number (every rail route in this feed
 * has an empty `route_short_name`).
 *
 * Deliberately not a full `RouteBrief` -- a search result can list a dozen
 * of these per stop and none of them is addressable, so `routeId` and
 * `longName` would be weight with nothing to spend it on.
 */
export interface StopRouteBrief {
  shortName: string;
  agencyId: string | null;
  type: number;
}

/**
 * What a list row needs about the lines calling at a stop: their badges,
 * whether trains call there, and which sign the row shows. The rail flag is
 * separate because rail has no badge to find it by: its routes carry no
 * number, so they never make `routes`.
 */
function linesAt(
  db: Database.Database,
  stopRef: number,
): { routes: StopRouteBrief[]; rail: boolean; stationKind: StationKind } {
  const rows = db.prepare(`
    SELECT DISTINCT r.route_short_name AS n, r.agency_id, r.route_type
    FROM stop_times st
    JOIN trips t  ON t.trip_ref = st.trip_ref
    JOIN routes r ON r.route_id = t.route_id
    WHERE st.stop_ref = ?
    ORDER BY CAST(n AS INTEGER), n
  `).all(stopRef) as { n: string | null; agency_id: string | null; route_type: number | null }[];
  return {
    routes: rows
      .filter((r) => r.n !== null && r.n !== "")
      .map((r) => ({ shortName: r.n!, agencyId: r.agency_id, type: r.route_type ?? 3 })),
    rail: rows.some((r) => r.route_type === RAIL_ROUTE_TYPE),
    stationKind: stationKindAt(db, stopRef),
  };
}

export function searchStops(
  db: Database.Database,
  tr: Translator,
  opts: { q: string; lang: Lang; limit: number; offset?: number },
): (StopSummary & { routes: StopRouteBrief[]; rail: boolean; stationKind: StationKind })[] {
  const offset = opts.offset ?? 0;

  // No query at all: browse mode. The tabs open on this before the rider
  // has typed, and there is no relevance to rank by -- so it is a plain
  // alphabetical page, not FTS with an empty needle (which matches
  // nothing). Ordered by stop_ref within equal names so paging is stable.
  //
  // Note this orders by the RAW `stop_name`, the Hebrew feed value, not the
  // translated one. A deliberate limitation: translations live in a separate
  // table and sorting by them would need a join per page for a list nobody
  // scrolls far into. Sorting in JS after the LIMIT is not a fix — it would
  // only sort each page within itself.
  if (opts.q.trim() === "") {
    const rows = db.prepare(`
      SELECT ${STOP_COLS} FROM stops
      ORDER BY stop_name, stop_ref LIMIT ? OFFSET ?
    `).all(opts.limit, offset) as StopRow[];
    return rows.map((row) => ({
      ...toSummary(row, tr, opts.lang),
      ...linesAt(db, row.stop_ref),
    }));
  }

  const match = ftsQuery(opts.q);
  if (match === "") return [];

  const byRef = new Map<number, StopRow>();

  // 1. Hebrew feed text, via the FTS5 index the fetcher builds.
  const ftsRows = db.prepare(`
    SELECT ${STOP_COLS} FROM stops
    WHERE stop_ref IN (SELECT stop_ref FROM stops_fts WHERE stops_fts MATCH ?)
    LIMIT ?
  `).all(match, opts.limit * 4) as StopRow[];
  for (const row of ftsRows) byRef.set(row.stop_ref, row);

  // 2. Translated names, which the FTS index does not cover at all.
  const names = tr.namesMatching(opts.q, opts.lang, opts.limit * 4);
  if (names.length > 0) {
    const placeholders = names.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT ${STOP_COLS} FROM stops WHERE stop_name IN (${placeholders}) LIMIT ?`,
    ).all(...names, opts.limit * 4) as StopRow[];
    for (const row of rows) byRef.set(row.stop_ref, row);
  }

  const needle = opts.q.trim().toLowerCase();
  return [...byRef.values()]
    .map((row) => ({ ...toSummary(row, tr, opts.lang), _ref: row.stop_ref }))
    // Prefix matches first — someone typing "הרצל" wants the stop called
    // exactly that above one merely containing it.
    .sort((a, b) => {
      const aPre = (a.name ?? "").toLowerCase().startsWith(needle) ? 0 : 1;
      const bPre = (b.name ?? "").toLowerCase().startsWith(needle) ? 0 : 1;
      if (aPre !== bPre) return aPre - bPre;
      return (a.name ?? "").localeCompare(b.name ?? "");
    })
    .slice(offset, offset + opts.limit)
    .map(({ _ref, ...summary }) => ({ ...summary, ...linesAt(db, _ref) }));
}

export function nearbyStops(
  db: Database.Database,
  tr: Translator,
  opts: { lat: number; lon: number; radiusMeters: number; limit: number; lang: Lang },
): (StopSummary & { distanceMeters: number; routes: StopRouteBrief[]; rail: boolean; stationKind: StationKind })[] {
  const box = bboxAround(opts.lat, opts.lon, opts.radiusMeters);

  // The R*Tree gives a rectangle; the exact circle is applied below. The
  // rectangle is always a superset, so nothing inside the radius is lost.
  const rows = db.prepare(`
    SELECT ${STOP_COLS} FROM stops
    WHERE stop_ref IN (
      SELECT stop_ref FROM stops_rtree
      WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
    )
  `).all(box.minLat, box.maxLat, box.minLon, box.maxLon) as StopRow[];

  return rows
    .map((row) => ({
      ...toSummary(row, tr, opts.lang),
      distanceMeters: haversineMeters([opts.lat, opts.lon], [row.stop_lat, row.stop_lon]),
      _ref: row.stop_ref,
    }))
    .filter((s) => s.distanceMeters <= opts.radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    // Sliced BEFORE the per-stop route lookup: linesAt is a query
    // each, and the rectangle can return far more stops than the limit.
    .slice(0, opts.limit)
    .map(({ _ref, ...stop }) => ({ ...stop, ...linesAt(db, _ref) }));
}

/**
 * The widest box `stopsInBox` answers, in degrees on either axis -- about
 * 5.5 km north-south. A map zoomed out past that is showing a city rather
 * than streets, where a pin per stop is noise; refusing it server-side keeps
 * a client bug from asking for the whole country.
 */
export const STOPS_BOX_MAX_SPAN_DEG = 0.05;

/** A stop as a map draws it: where, what it is called, and which sign. No
 *  lines -- those are a query per stop, and a map box holds hundreds. */
export interface MapStop {
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
  rail: boolean;
  stationKind: StationKind;
}

/**
 * Every stop whose sign is not the bus stop's, found once per database: a map
 * box pins hundreds of stops, and a list row already costs a query each. The
 * feed swaps its database on reload, so keying on the handle retires the map
 * with it.
 */
const stationKindsByDb = new WeakMap<Database.Database, Map<number, StationKind>>();

/** The sign a stop shows, by everything that calls there -- see
 *  `transit/stationKind.ts`. */
function stationKindAt(db: Database.Database, stopRef: number): StationKind {
  let kinds = stationKindsByDb.get(db);
  if (kinds === undefined) {
    const codes = [...METRONIT_LINE_CODES];
    const rows = db.prepare(`
      SELECT DISTINCT st.stop_ref AS ref, r.route_type AS type, r.agency_id AS agencyId,
                      r.route_desc AS routeDesc
      FROM routes r
      JOIN trips t       ON t.route_id = r.route_id
      JOIN stop_times st ON st.trip_ref = t.trip_ref
      WHERE r.route_type IN (?, ?)
         OR r.agency_id = ?
         OR substr(r.route_desc, 1, instr(r.route_desc, '-') - 1) IN (${codes.map(() => "?").join(", ")})
    `).all(RAIL_ROUTE_TYPE, LIGHT_RAIL_ROUTE_TYPE, CARMELIT_AGENCY_ID, ...codes) as {
      ref: number; type: number | null; agencyId: string | null; routeDesc: string | null;
    }[];
    const routesByRef = new Map<number, SignRoute[]>();
    for (const row of rows) {
      const routes = routesByRef.get(row.ref) ?? [];
      routes.push({ type: row.type, agencyId: row.agencyId, desc: row.routeDesc });
      routesByRef.set(row.ref, routes);
    }
    kinds = new Map([...routesByRef].map(([ref, routes]) => [ref, stationKindOf(routes)]));
    stationKindsByDb.set(db, kinds);
  }
  return kinds.get(stopRef) ?? "bus";
}

/**
 * The stops inside a map's visible box, for pinning.
 *
 * Only stops a rider can board at: a parent station (`location_type` 1) would
 * draw a second pin on top of its own platforms, and the feed carries
 * thousands of stops no trip calls at any more.
 */
export function stopsInBox(
  db: Database.Database,
  tr: Translator,
  opts: { minLat: number; maxLat: number; minLon: number; maxLon: number; limit: number; lang: Lang },
): MapStop[] {
  const rows = db.prepare(`
    SELECT s.stop_ref, s.stop_id, s.stop_name, s.stop_lat, s.stop_lon FROM stops s
    WHERE s.stop_ref IN (
      SELECT stop_ref FROM stops_rtree
      WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
    )
      AND COALESCE(s.location_type, 0) = 0
      AND EXISTS (SELECT 1 FROM stop_times st WHERE st.stop_ref = s.stop_ref)
    LIMIT ?
  `).all(opts.minLat, opts.maxLat, opts.minLon, opts.maxLon, opts.limit) as
    Pick<StopRow, "stop_ref" | "stop_id" | "stop_name" | "stop_lat" | "stop_lon">[];

  return rows.map((row) => ({
    stopId: row.stop_id,
    name: tr.resolve(row.stop_name, opts.lang),
    lat: row.stop_lat,
    lon: row.stop_lon,
    // Trains outrank every other sign, so a train sign is exactly "trains call".
    rail: stationKindAt(db, row.stop_ref) === "train",
    stationKind: stationKindAt(db, row.stop_ref),
  }));
}

export function getStop(
  db: Database.Database,
  tr: Translator,
  stopId: string,
  lang: Lang,
): StopDetail | null {
  const row = db.prepare(`SELECT ${STOP_COLS} FROM stops WHERE stop_id = ?`)
    .get(stopId) as StopRow | undefined;
  if (row === undefined) return null;

  const children = (db.prepare(`SELECT ${STOP_COLS} FROM stops WHERE parent_station = ?`)
    .all(stopId) as StopRow[]).map((c) => toSummary(c, tr, lang));

  const routes = (db.prepare(`
    SELECT DISTINCT r.route_id, r.agency_id, r.route_short_name, r.route_long_name,
                    r.route_type, r.route_color
    FROM stop_times st
    JOIN trips t  ON t.trip_ref = st.trip_ref
    JOIN routes r ON r.route_id = t.route_id
    WHERE st.stop_ref = ?
  `).all(row.stop_ref) as {
    route_id: string; agency_id: string | null; route_short_name: string | null;
    route_long_name: string | null;
    route_type: number | null; route_color: string | null;
  }[]).map((r) => ({
    routeId: r.route_id,
    agencyId: r.agency_id,
    shortName: r.route_short_name,
    // route_long_name has zero translation coverage in this feed — it stays
    // Hebrew whatever `lang` says.
    longName: r.route_long_name,
    type: r.route_type ?? 3,
    color: r.route_color === "" ? null : r.route_color,
  }));

  return {
    ...toSummary(row, tr, lang),
    desc: tr.resolve(row.stop_desc, lang),
    stationKind: stationKindAt(db, row.stop_ref),
    children,
    routes,
  };
}

/**
 * A stop plus every stop sharing its station: the platforms of a station, or
 * a platform's station and its siblings. Returns just the stop itself when it
 * belongs to no station.
 */
/**
 * Whether a stop id exists at all, independent of anything else about it.
 *
 * `/stops/:stopId/departures` needs this because "does this stop exist" and
 * "which stop ids does this board cover" are two different questions, and
 * conflating them made an unknown id a 404 with `includeSiblings=true` (via
 * `siblingStopIds` returning an empty list) but a `200` with an empty board
 * with `includeSiblings=false` (which never consulted the database at all).
 * Same endpoint, same input, different semantics, decided by an unrelated
 * flag.
 */
export function stopExists(db: Database.Database, stopId: string): boolean {
  return db.prepare("SELECT 1 FROM stops WHERE stop_id = ?").get(stopId) !== undefined;
}

export function siblingStopIds(db: Database.Database, stopId: string): string[] {
  const row = db.prepare(
    "SELECT stop_id, location_type, parent_station FROM stops WHERE stop_id = ?",
  ).get(stopId) as { stop_id: string; location_type: number | null; parent_station: string | null } | undefined;
  if (row === undefined) return [];

  const station = row.location_type === 1
    ? row.stop_id
    : (row.parent_station === "" ? null : row.parent_station);
  if (station === null) return [row.stop_id];

  const kin = db.prepare(
    "SELECT stop_id FROM stops WHERE stop_id = ? OR parent_station = ?",
  ).all(station, station) as { stop_id: string }[];
  return kin.map((k) => k.stop_id);
}
