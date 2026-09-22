import type { RealtimeJourney } from "./types.js";

/**
 * Parses the Public Knowledge Workshop's Stride feed
 * (`/siri_vehicle_locations/list`) into the same `RealtimeJourney` shape
 * `siri.ts` produces, so one matcher and one store serve both sources.
 *
 * The crucial difference, and the reason this file is shaped the way it is:
 * **Stride publishes SIRI-VM, not SIRI-SM.** There is no predicted arrival
 * time anywhere in its schema — verified against every `Siri*` model in its
 * OpenAPI document; the only `actual_arrival_time` lives on
 * `/stop_arrivals`, a historical table whose newest row is from 2023.
 *
 * So every journey this file produces has an EMPTY `calls` array and is
 * deliberately useless on its own. `match.ts`'s `predictFromDistance`
 * derives the per-stop predictions afterwards, from `distanceFromStart`
 * against the matched trip's own `stopDistance`. That two-step shape is the
 * whole design of the fallback.
 */

export interface StrideSnapshot {
  journeys: RealtimeJourney[];
  /** Every entry the payload carried, whether or not it survived. */
  rowsSeen: number;
  /**
   * Of `rowsSeen`, how many were dropped — unusable fields, or a ghost past
   * the age cutoff. Reported for the same reason `SiriSnapshot.visitsDropped`
   * is: `0 journeys` from a genuinely quiet feed and `0 journeys` from a
   * payload where every row was rejected are indistinguishable from
   * `journeys.length` alone, and they need very different responses.
   */
  rowsDropped: number;
}

export interface StrideQuery {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
  limit: number; offset: number;
  /**
   * Restricts the query to ONE snapshot. Not optional in practice -- see
   * `snapshotsUrl` for why an unscoped query is both wrong and wasteful.
   */
  snapshotId: number;
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

/**
 * Stride returns real JSON numbers, unlike the ministry's SIRI, whose every
 * numeric arrives as a string — but a null, or an unexpected string, must
 * still never reach a caller as `NaN`. Same contract as `siri.ts`'s own
 * `toFiniteNumber`: a finite number, or `null`, never anything else.
 */
function toFiniteNumber(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string" || x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** ISO 8601 with an offset, to epoch SECONDS — the unit every other time in
 *  this codebase uses. `null` for anything unparseable, never `NaN`. */
function toEpochSeconds(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** `"2026-08-31-585444066"` — a service date, then the ministry's own ride
 *  id. Only the date half is usable; see `parseRow`. */
const JOURNEY_REF = /^(\d{4}-\d{2}-\d{2})-/;

/**
 * One `/siri_vehicle_locations/list` row, or `null` if it cannot become a
 * usable journey.
 *
 * Dropped — never thrown on — when it lacks the route, the scheduled start,
 * the journey ref (which carries the service date), or a readable
 * `recorded_at_time`. Without any one of those the journey either cannot be
 * matched to a trip or cannot be aged, and one malformed row must never
 * take a whole national snapshot down with it. Same contract as
 * `siri.ts`'s `parseVisit`.
 */
function parseRow(
  raw: unknown, now: number, maxVehicleAgeSeconds: number,
): RealtimeJourney | null {
  const row = asRecord(raw);
  if (row === null) return null;

  // Our `routes.route_id` is a string; Stride sends the same value as a JSON
  // number. Checked against a live snapshot: all 1,675 distinct line_refs
  // matched a route_id under exactly this conversion.
  const lineRef = toFiniteNumber(row["siri_route__line_ref"]);
  if (lineRef === null) return null;

  // True UTC, not naive local time stamped "+00:00" — confirmed by bucketing
  // scheduled hours against the wall clock on a live snapshot: the
  // distribution peaks at the current UTC hour. Reading these as local would
  // shift every journey three hours and match nothing.
  const originAimedDeparture = toEpochSeconds(row["siri_ride__scheduled_start_time"]);
  if (originAimedDeparture === null) return null;

  const recordedAt = toEpochSeconds(row["recorded_at_time"]);
  if (recordedAt === null) return null;

  // Ghost rides: a vehicle keeps reappearing in snapshots long after it stops
  // reporting — one observed 34 minutes stale. Dropped HERE, before matching,
  // so a dead vehicle can never pin a fresh snapshot's age or occupy a trip
  // a live vehicle should own.
  //
  // Deliberately NOT `REALTIME_MAX_AGE_SECONDS` (180 s), which measures how
  // old the whole SNAPSHOT may be -- i.e. how long since WE fetched. This
  // measures how old the VEHICLE's own report is, and the two differ by
  // Stride's ingestion lag, which is large and load-dependent: measured
  // across 399 consecutive snapshots on 2026-09-01, 0.5 min overnight but
  // 14-19 min throughout the service peak, max 23.7 min. Reusing the
  // snapshot number here drops the entire feed during the day.
  if (now - recordedAt > maxVehicleAgeSeconds) return null;

  // The service date, which is what `selectDay` matches a DayContext on. It
  // is NOT derivable from the timestamps above: a 23:40 local departure falls
  // on the previous UTC day for part of the year.
  const journeyRef = row["siri_ride__journey_ref"];
  const dated = typeof journeyRef === "string" ? JOURNEY_REF.exec(journeyRef) : null;
  if (dated === null) return null;

  const operatorRef = toFiniteNumber(row["siri_route__operator_ref"]);
  const vehicleRef = row["siri_ride__vehicle_ref"];

  return {
    lineRef: String(lineRef),
    // Stride never reports a direction. `resolveJourney` recovers it from
    // the route — see `TripLookup.directionByRouteId`.
    directionId: null,
    // `dated[1]!`: JOURNEY_REF has exactly one capture group and matched.
    dataFrameRef: dated[1]!,
    datedVehicleJourneyRef: journeyRef as string,
    originAimedDeparture,
    operatorRef: operatorRef === null ? null : String(operatorRef),
    // Stride carries no published line name; the GTFS route supplies it.
    publishedLineName: null,
    vehicleRef: typeof vehicleRef === "string" && vehicleRef.length > 0 ? vehicleRef : null,
    // SIRI-VM has no confidence concept, and `confidence` stays documented as
    // SIRI's own — it is NOT overloaded to carry provenance. The public
    // `source` field does that job.
    confidence: null,
    lat: toFiniteNumber(row["lat"]),
    lon: toFiniteNumber(row["lon"]),
    recordedAt,
    // No predictions exist in this feed; they are derived after matching.
    calls: [],
    // `toFiniteNumber`, never `?? 0` or a falsy check: a vehicle at its
    // origin legitimately reports 0, and conflating that with "unknown"
    // would make predictFromDistance place it at the start of a trip whose
    // position it does not actually know.
    distanceFromStart: toFiniteNumber(row["distance_from_journey_start"]),
  };
}

export function parseStrideRows(
  payload: unknown, opts: { now: number; maxVehicleAgeSeconds: number },
): StrideSnapshot {
  // Every error shape this API produces is a non-array body — the "due to
  // abuse" cap message, a pydantic validation error, an HTML error page.
  // Reported as an empty snapshot rather than thrown: deciding that a tick
  // FAILED (as opposed to being legitimately quiet) is the poller's job, and
  // it distinguishes the two by checking `Array.isArray` itself.
  if (!Array.isArray(payload)) return { journeys: [], rowsSeen: 0, rowsDropped: 0 };

  const journeys: RealtimeJourney[] = [];
  let rowsDropped = 0;
  for (const raw of payload) {
    const journey = parseRow(raw, opts.now, opts.maxVehicleAgeSeconds);
    if (journey === null) rowsDropped++;
    else journeys.push(journey);
  }
  return { journeys, rowsSeen: payload.length, rowsDropped };
}

/**
 * The snapshot list, newest first. One small request per tick, and the
 * reason for it is not efficiency but CORRECTNESS.
 *
 * Every vehicle reappears in EVERY snapshot while its ride is running, and
 * snapshots land once a minute. An unscoped `/siri_vehicle_locations` query
 * therefore returns the same vehicle many times over -- measured against
 * the live feed, 45,000 rows carried only 8,841 distinct rides, a median of
 * 5 copies each and up to 15. Rows arrive newest-first, so a map keyed on
 * trip and filled in payload order ends up holding each vehicle's OLDEST
 * position, not its newest: predictions built from an observation minutes
 * staler than the one we already had in hand.
 *
 * Scoping to a single snapshot removes the duplication at the source. It
 * also cuts the load we put on a volunteer-run database by about 5x, which
 * their own documentation explicitly asks callers to do.
 */
export function snapshotsUrl(baseUrl: string, limit = 5): string {
  const params = new URLSearchParams({ limit: String(limit), order_by: "id desc" });
  return `${baseUrl.replace(/\/+$/, "")}/siri_snapshots/list?${params}`;
}

/**
 * The newest snapshot that has finished loading, or `null` if the payload
 * carries none.
 *
 * `etl_status === "loaded"` matters: the newest row is routinely still
 * `"loading"`, and querying a partially-written snapshot would return
 * whatever fraction of the country had been inserted so far -- which looks
 * exactly like "these buses have no realtime" rather than like an error.
 */
export function latestLoadedSnapshotId(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null;
  for (const raw of payload) {
    const row = asRecord(raw);
    if (row === null) continue;
    if (row["etl_status"] !== "loaded") continue;
    const id = toFiniteNumber(row["id"]);
    if (id !== null) return id;
  }
  return null;
}

export function strideUrl(baseUrl: string, q: StrideQuery): string {
  const params = new URLSearchParams({
    limit: String(q.limit),
    offset: String(q.offset),
    siri_snapshot_ids: String(q.snapshotId),
    lat__greater_or_equal: String(q.minLat),
    lat__lower_or_equal: String(q.maxLat),
    lon__greater_or_equal: String(q.minLon),
    lon__lower_or_equal: String(q.maxLon),
    // Offset paging over an unordered result set can repeat or skip rows
    // between pages. `id` is the only monotonic column, and descending puts
    // the newest snapshot's rows on the first page — so a truncated tick
    // loses the OLDEST vehicles, not a random scattering of them.
    order_by: "id desc",
  });
  return `${baseUrl.replace(/\/+$/, "")}/siri_vehicle_locations/list?${params}`;
}
