import Database from "better-sqlite3";
import { buildPatterns, type PatternSet, type TripTimes } from "./patterns.js";
import { RAIL_ROUTE_TYPE } from "./routeTypes.js";
import { rawHeadsignOf, tripNumberOf } from "../db/tripHeadsign.js";

export interface TimetableIndex extends PatternSet {
  version: string;

  nStops: number;
  stopIds: string[];
  stopIdToIdx: Map<string, number>;
  stopNames: (string | null)[];
  /**
   * GTFS `stop_code` — the field SIRI sends as `MonitoringRef`/
   * `StopPointRef`. Not unique: about a thousand stops in this
   * feed share a code with another stop, so `match.ts` resolves a code to
   * one of possibly several indices here, disambiguated against a trip's
   * own stop sequence. Carried on the index (not looked up from the
   * database at match time) so realtime resolution stays in-memory, like
   * everything else RAPTOR touches.
   */
  stopCodes: (string | null)[];
  stopLat: Float64Array;
  stopLon: Float64Array;
  /** Station stop index, or -1 when the stop belongs to no station. */
  stopParent: Int32Array;

  nTrips: number;
  tripIds: string[];
  /**
   * Reverse lookup for `tripIds`, precomputed once per index bundle --
   * the same reasoning `stopIdToIdx` above documents, and the same fix
   * `match.ts`'s `TripLookup` already applies for its own trip-key map:
   * built once here rather than walking all `nTrips` entries on every
   * request that needs to go from a GTFS trip id (all a `TransitLeg` or
   * a `Departure` carries) back to the RAPTOR trip index a
   * `RealtimeStore` is keyed on (`routes/plan.ts`'s and
   * `routes/departures.ts`'s realtime annotation).
   */
  tripIdToIdx: Map<string, number>;
  /**
   * The UNTRANSLATED headsign a rider should see -- for a rail trip, its last
   * stop's raw name, NOT the feed's `trip_headsign` (which for rail is the
   * train number; see `db/tripHeadsign.ts`). Display only: nothing in
   * routing, ranking or realtime matching reads it.
   */
  tripHeadsigns: (string | null)[];
  /** Parallel to `tripHeadsigns`: the train number for a rail trip, else null. */
  tripNumbers: (string | null)[];
  serviceIds: string[];
  tripServiceIdx: Int32Array;
  routeIds: string[];
  tripRouteIdx: Int32Array;
  tripDirection: Int8Array;
  /** GTFS wheelchair_accessible: 0 unknown, 1 accessible, 2 not. */
  tripWheelchair: Int8Array;

  /** Trip t's times occupy [tripTimeOffset[t], tripTimeOffset[t+1]). */
  tripTimeOffset: Int32Array;
  arrivalTime: Int32Array;
  departureTime: Int32Array;
  /**
   * Metres along the trip's shape at each stop, parallel to `arrivalTime`
   * and indexed identically (`tripTimeOffset[t] + pos`).
   *
   * `-1` marks a `stop_times` row with no `shape_dist_traveled` — measured
   * feed-wide, 13,169 of 14,813,283 rows (0.1%). That sentinel cannot be 0,
   * because 0 is the legitimate distance of every trip's FIRST stop;
   * conflating them would let
   * `predictFromDistance` place a vehicle at the origin of a trip whose
   * distances it actually knows nothing about.
   *
   * Exists solely for `realtime/match.ts`'s `predictFromDistance`, which
   * locates a SIRI-VM vehicle between two stops by the distance the feed
   * reports for it. 14.8M rows x 4 B = 56.5 MB, the single largest memory
   * cost of the realtime fallback -- a lazy, per-trip cache would trade that
   * memory for lookup cost if the memory budget ever tightens.
   */
  stopDistance: Int32Array;

  /** For stop s, the patterns serving it: [stopPatternOffset[s], ...offset[s+1]). */
  stopPatterns: Int32Array;
  /** The stop's position within that pattern, parallel to stopPatterns. */
  stopPatternPos: Int32Array;
  stopPatternOffset: Int32Array;

  /** Footpaths, attached separately by attachFootpaths. */
  footOffset: Int32Array;
  footTarget: Int32Array;
  footSeconds: Int32Array;
  /**
   * True only when the footpaths currently attached were computed by
   * routing through Valhalla (`FootpathMode: "valhalla"`, including a
   * cache hit -- only a real Valhalla result is ever cached, see
   * `IndexManager.attachFootpathsTo`'s own comment). False for a
   * straight-line-degraded index, AND for a freshly built index with no
   * footpaths attached at all yet -- an index that has not been told
   * otherwise claims nothing about its footpaths' provenance. Read by
   * `itinerary.ts` to decide whether a mid-itinerary transfer leg's
   * duration is a real routed walking time (see its own `walkEstimated`
   * derivation).
   *
   * This is INDEX-WIDE, not per-edge, and can over-claim on an individual
   * edge in two distinct ways:
   *  - a partial Valhalla failure for one stop during a build still leaves
   *    the whole index `true` if `ping()` itself succeeded, since
   *    `FootpathMode` records only that;
   *  - routine, not rare: `buildFootpaths` (`footpaths.ts`) falls back to
   *    `straightLineWalk` **per pair** whenever a single matrix cell comes
   *    back null or non-finite, while `mode` stays `"valhalla"` for the
   *    whole build -- so a transfer leg whose own edge was individually
   *    estimated (a barrier, a gap in the street graph Valhalla could not
   *    route across, ...) still reports `walkEstimated: false`, same as
   *    every genuinely routed edge around it.
   * Neither case is tracked per edge today -- the recorded follow-up (a
   * cache-format change) is deliberately not done here.
   */
  footpathsRouted: boolean;
}

/**
 * The one place this file opens the GTFS database, extracted as its own
 * export so other tools that need to read the same file can do so the same
 * way without resolving `better-sqlite3` from their own directory. Read-only
 * and fail-loud on a missing file, exactly as `buildIndex` requires.
 */
export function openReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function buildIndex(dbPath: string): TimetableIndex {
  const db = openReadOnly(dbPath);
  try {
    // --- stops ------------------------------------------------------------
    const stopRows = db.prepare(`
      SELECT stop_ref, stop_id, stop_code, stop_name, stop_lat, stop_lon, parent_station
      FROM stops ORDER BY stop_ref
    `).all() as {
      stop_ref: number; stop_id: string; stop_code: string | null; stop_name: string | null;
      stop_lat: number | null; stop_lon: number | null; parent_station: string | null;
    }[];

    const nStops = stopRows.length;
    const stopIds: string[] = new Array<string>(nStops);
    // Names live on the index so an itinerary can be rendered without a
    // database round-trip per stop.
    const stopNames: (string | null)[] = new Array<string | null>(nStops);
    const stopCodes: (string | null)[] = new Array<string | null>(nStops);
    const stopIdToIdx = new Map<string, number>();
    const refToStopIdx = new Map<number, number>();
    const stopLat = new Float64Array(nStops);
    const stopLon = new Float64Array(nStops);
    const stopParent = new Int32Array(nStops).fill(-1);

    for (let i = 0; i < nStops; i++) {
      const r = stopRows[i]!;
      stopIds[i] = r.stop_id;
      stopNames[i] = r.stop_name;
      stopCodes[i] = r.stop_code;
      stopIdToIdx.set(r.stop_id, i);
      refToStopIdx.set(r.stop_ref, i);
      stopLat[i] = r.stop_lat ?? 0;
      stopLon[i] = r.stop_lon ?? 0;
    }
    // Second pass: parents are stop_ids, resolvable only once every stop is mapped.
    for (let i = 0; i < nStops; i++) {
      const parent = stopRows[i]!.parent_station;
      if (parent !== null && parent !== "") {
        stopParent[i] = stopIdToIdx.get(parent) ?? -1;
      }
    }

    // --- routes -----------------------------------------------------------
    const routeRows = db.prepare("SELECT route_id, route_type FROM routes ORDER BY route_id")
      .all() as { route_id: string; route_type: number | null }[];
    const routeIds = routeRows.map((r) => r.route_id);
    const routeTypes = routeRows.map((r) => r.route_type);
    const routeIdToIdx = new Map(routeIds.map((id, i) => [id, i] as const));

    // --- trips ------------------------------------------------------------
    const tripRows = db.prepare(`
      SELECT trip_ref, trip_id, route_id, service_id, trip_headsign,
             direction_id, wheelchair_accessible
      FROM trips ORDER BY trip_ref
    `).all() as {
      trip_ref: number; trip_id: string; route_id: string | null;
      service_id: string | null; trip_headsign: string | null;
      direction_id: number | null; wheelchair_accessible: number | null;
    }[];

    const nTrips = tripRows.length;
    const tripIds: string[] = new Array<string>(nTrips);
    const tripIdToIdx = new Map<string, number>();
    const tripHeadsigns: (string | null)[] = new Array<string | null>(nTrips);
    const refToTripIdx = new Map<number, number>();
    const serviceIds: string[] = [];
    const serviceIdToIdx = new Map<string, number>();
    const tripServiceIdx = new Int32Array(nTrips).fill(-1);
    const tripRouteIdx = new Int32Array(nTrips).fill(-1);
    const tripDirection = new Int8Array(nTrips);
    const tripWheelchair = new Int8Array(nTrips);

    for (let i = 0; i < nTrips; i++) {
      const r = tripRows[i]!;
      tripIds[i] = r.trip_id;
      // `trips.trip_id` is `NOT NULL UNIQUE` (schema), so this is a true
      // 1:1 reverse lookup -- never overwritten by a later, colliding trip.
      tripIdToIdx.set(r.trip_id, i);
      tripHeadsigns[i] = r.trip_headsign;
      refToTripIdx.set(r.trip_ref, i);
      if (r.service_id !== null) {
        let s = serviceIdToIdx.get(r.service_id);
        if (s === undefined) {
          s = serviceIds.length;
          serviceIds.push(r.service_id);
          serviceIdToIdx.set(r.service_id, s);
        }
        tripServiceIdx[i] = s;
      }
      if (r.route_id !== null) tripRouteIdx[i] = routeIdToIdx.get(r.route_id) ?? -1;
      tripDirection[i] = r.direction_id ?? 0;
      tripWheelchair[i] = r.wheelchair_accessible ?? 0;
    }

    // --- stop_times -------------------------------------------------------
    // Measured at 2.36 s for 9,817,029 rows. `.raw()` returns plain arrays
    // rather than objects, which is what makes a scan this size affordable —
    // materialising 9.8M row objects is several times slower and allocates
    // heavily.
    const nTimes = (db.prepare("SELECT COUNT(*) AS n FROM stop_times")
      .get() as { n: number }).n;

    const timeStops = new Int32Array(nTimes);
    const arrivalTime = new Int32Array(nTimes);
    const departureTime = new Int32Array(nTimes);
    const stopDistance = new Int32Array(nTimes);
    // -1 marks "not yet seen"; 0 cannot serve as that sentinel because it is a
    // valid offset for the first trip.
    const tripTimeOffset = new Int32Array(nTrips + 1).fill(-1);

    const stmt = db.prepare(`
      SELECT trip_ref, stop_ref, arrival_time, departure_time, shape_dist_traveled
      FROM stop_times ORDER BY trip_ref, stop_sequence
    `).raw();

    let cursor = 0;
    let currentTrip = -1;
    for (const row of stmt.iterate() as Iterable<
      [number, number, number | null, number | null, number | null]
    >) {
      const tripIdx = refToTripIdx.get(row[0]);
      // A stop_time whose trip is absent from trips.txt cannot be placed. The
      // fetcher's sanity gates make this impossible, but silently writing at a
      // -1 index would corrupt the arrays rather than fail.
      if (tripIdx === undefined) continue;
      if (tripIdx !== currentTrip) {
        // Rows are ordered by trip_ref, so each trip's block starts once.
        tripTimeOffset[tripIdx] = cursor;
        currentTrip = tripIdx;
      }
      timeStops[cursor] = refToStopIdx.get(row[1]) ?? -1;
      // Raw GTFS seconds. Never clamped: values above 86400 are real.
      arrivalTime[cursor] = row[2] ?? 0;
      departureTime[cursor] = row[3] ?? 0;
      // Rounded to whole metres. The feed states these in metres already,
      // with a spurious fractional tail; predictFromDistance interpolates
      // over spans of hundreds of metres, so sub-metre precision buys
      // nothing and Int32 costs half what Float64 would.
      stopDistance[cursor] = row[4] === null ? -1 : Math.round(row[4]);
      cursor++;
    }
    tripTimeOffset[nTrips] = cursor;

    // Trips with no stop_times at all never had their offset written. Walking
    // backwards and inheriting the next trip's start gives them an empty
    // [offset[t], offset[t+1]) range, which every consumer handles correctly.
    // The sentinel is -1 rather than 0, because 0 is a legitimate offset for
    // the first trip.
    for (let t = nTrips - 1; t >= 0; t--) {
      if (tripTimeOffset[t] === -1) tripTimeOffset[t] = tripTimeOffset[t + 1]!;
    }

    // --- rail headsigns ---------------------------------------------------
    // A rail trip's `trip_headsign` is its train number, not a destination
    // (see `db/tripHeadsign.ts`). Swapped here, once, for the trip's last
    // stop -- the last row of its block, since stop_times was read ordered by
    // (trip_ref, stop_sequence) -- so every leg built from this index shows
    // where the train is going, with the number kept alongside.
    const tripNumbers: (string | null)[] = new Array<string | null>(nTrips).fill(null);
    for (let t = 0; t < nTrips; t++) {
      const routeIdx = tripRouteIdx[t]!;
      const routeType = routeIdx === -1 ? null : routeTypes[routeIdx] ?? null;
      if (routeType !== RAIL_ROUTE_TYPE) continue;
      const last = tripTimeOffset[t + 1]! - 1;
      const lastStop = last >= tripTimeOffset[t]! ? timeStops[last]! : -1;
      const lastName = lastStop === -1 ? null : stopNames[lastStop] ?? null;
      tripNumbers[t] = tripNumberOf(routeType, tripHeadsigns[t] ?? null);
      tripHeadsigns[t] = rawHeadsignOf(routeType, tripHeadsigns[t] ?? null, lastName);
    }

    // --- patterns ---------------------------------------------------------
    const trips: TripTimes[] = new Array<TripTimes>(nTrips);
    for (let t = 0; t < nTrips; t++) {
      const from = tripTimeOffset[t]!;
      const to = tripTimeOffset[t + 1]!;
      trips[t] = {
        stops: timeStops.subarray(from, to),
        arrivals: arrivalTime.subarray(from, to),
        departures: departureTime.subarray(from, to),
      };
    }
    const patterns = buildPatterns(trips);

    // --- stop -> patterns inverted index ----------------------------------
    // Two passes: count, then fill. A stop may appear more than once in a
    // pattern (a loop route), so each (pattern, position) pair gets an entry.
    const counts = new Int32Array(nStops);
    for (let p = 0; p < patterns.nPatterns; p++) {
      const from = patterns.patternStopOffset[p]!;
      const to = patterns.patternStopOffset[p + 1]!;
      for (let i = from; i < to; i++) {
        const s = patterns.patternStops[i]!;
        if (s >= 0) counts[s]!++;
      }
    }
    const stopPatternOffset = new Int32Array(nStops + 1);
    for (let s = 0; s < nStops; s++) {
      stopPatternOffset[s + 1] = stopPatternOffset[s]! + counts[s]!;
    }
    const stopPatterns = new Int32Array(stopPatternOffset[nStops]!);
    const stopPatternPos = new Int32Array(stopPatternOffset[nStops]!);
    const fill = stopPatternOffset.slice(0, nStops);
    for (let p = 0; p < patterns.nPatterns; p++) {
      const from = patterns.patternStopOffset[p]!;
      const to = patterns.patternStopOffset[p + 1]!;
      for (let i = from; i < to; i++) {
        const s = patterns.patternStops[i]!;
        if (s < 0) continue;
        const at = fill[s]!;
        stopPatterns[at] = p;
        stopPatternPos[at] = i - from;
        fill[s] = at + 1;
      }
    }

    const version = (db.prepare("SELECT value FROM feed_meta WHERE key = 'version'")
      .get() as { value: string } | undefined)?.value ?? "unknown";

    return {
      ...patterns,
      version,
      nStops, stopIds, stopNames, stopCodes, stopIdToIdx, stopLat, stopLon, stopParent,
      nTrips, tripIds, tripIdToIdx, tripHeadsigns, tripNumbers, serviceIds, tripServiceIdx,
      routeIds, tripRouteIdx, tripDirection, tripWheelchair,
      tripTimeOffset, arrivalTime, departureTime, stopDistance,
      stopPatterns, stopPatternPos, stopPatternOffset,
      footOffset: new Int32Array(nStops + 1),
      footTarget: new Int32Array(0),
      footSeconds: new Int32Array(0),
      footpathsRouted: false,
    };
  } finally {
    db.close();
  }
}

/**
 * Footpaths are produced separately (they require Valhalla) and attached once
 * available. `offsets` has length nStops + 1; `targets` and `seconds` are
 * parallel flat arrays.
 */
export function attachFootpaths(
  index: TimetableIndex,
  offsets: Int32Array,
  targets: Int32Array,
  seconds: Int32Array,
): void {
  index.footOffset = offsets;
  index.footTarget = targets;
  index.footSeconds = seconds;
}
