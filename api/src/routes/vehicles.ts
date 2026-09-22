import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { toIso } from "../transit/calendar.js";
import type { TimetableIndex } from "../transit/index.js";
import { ANCHOR_MAX_REPORT_AGE_SECONDS, type RealtimeStore } from "../realtime/store.js";
import type { ResolvedJourney } from "../realtime/match.js";
import type { RealtimeJourney } from "../realtime/types.js";

/**
 * The most trips one request may ask about -- the same bound
 * `journeyCheck.ts` puts on a rider's remaining chain, for the same reason:
 * a real journey never names this many (`/plan` caps `maxTransfers` at 6,
 * i.e. 7 legs), so a larger list is a client bug or an attempt to walk the
 * whole index one request at a time.
 */
const MAX_TRIPS = 12;

/**
 * Whether this bus's position may be drawn as a dot. A dot claims to be where
 * the bus IS: a rider watching it lets one go by, or runs for one that has
 * already gone.
 *
 * With a MOT key the operator's own feed is trusted as it always was.
 *
 * On a keyless feed a bus is drawn only while its own report is at most
 * `ANCHOR_MAX_REPORT_AGE_SECONDS` (five minutes) old -- the same line the store
 * draws for trusting a report enough to anchor an ETA on it. It is the
 * report's age that decides, not the feed's name: the raw open-bus feed is
 * normally about a minute old, but Stride's weekday reports lag 13-23 minutes,
 * and on 2026-09-13 18:47Z every one of Egged's reports on the raw feed ran
 * ~21 minutes late too. A report with no RecordedAtTime has no age to judge,
 * so it is not drawn. The app shows each dot's age and dims an older one.
 */
function drawable(store: RealtimeStore, journey: RealtimeJourney): boolean {
  if (store.feedSource === "siri-sm") return true;
  if (journey.recordedAt === null) return false;
  return store.nowSeconds() - journey.recordedAt <= ANCHOR_MAX_REPORT_AGE_SECONDS;
}

/** One vehicle's current position. Absent entirely -- rather than present
 *  with null fields -- when there is nothing fresh to report for a trip. */
interface Vehicle {
  tripId: string;
  lat: number;
  lon: number;
  /** When the VEHICLE reported this, not when we fetched it. Null when the
   *  feed omitted `RecordedAtTime`; a client showing an age must then say
   *  nothing rather than assume "now". */
  recordedAt: string | null;
  vehicleRef: string | null;
}

/**
 * `trips=T1,T2` -> `["T1", "T2"]`. Blank entries are dropped and each id is
 * trimmed, so a hand-built or pretty-printed query (`trips=T1, T2`) resolves
 * the intended trips rather than missing on a literal `" T2"` -- no real
 * GTFS id this feed issues has leading space, so there is nothing legitimate
 * the trimming can break. Mirrors `journeyCheck.ts`'s `parseLeg`.
 *
 * Throws plain `Error` (never an HTTP type), turned into a 400 at the call
 * site, so parsing stays framework-agnostic the way every other route here
 * keeps it.
 */
function parseTrips(raw: string | undefined): string[] {
  const ids = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (ids.length === 0) {
    throw new Error("trips is required: a comma-separated list of trip ids");
  }
  if (ids.length > MAX_TRIPS) {
    throw new Error(`trips names ${ids.length} trips; at most ${MAX_TRIPS} are allowed`);
  }
  return ids;
}

/** A resolved journey as a dot, or null when it may not be drawn -- a report
 *  too old to vouch for, or no position at all. Half a coordinate is the same
 *  as none: `siri.ts` propagates an absent or unparseable `VehicleLocation` as
 *  null per axis rather than inventing one, so both are checked. */
function vehicleOf(
  store: RealtimeStore, ix: TimetableIndex, tz: string, resolved: ResolvedJourney,
): Vehicle | null {
  if (!drawable(store, resolved.journey)) return null;
  const { lat, lon, recordedAt, vehicleRef } = resolved.journey;
  if (lat === null || lon === null) return null;
  return {
    tripId: ix.tripIds[resolved.tripIdx]!, lat, lon,
    recordedAt: recordedAt === null ? null : toIso(recordedAt, tz),
    vehicleRef,
  };
}

/**
 * The positions this store can currently vouch for, in the order the trips
 * were asked about. Never throws: an id this index does not know, a trip
 * with no resolved journey, and a journey whose feed omitted
 * `VehicleLocation` all degrade to an omitted entry, exactly as
 * `departures.ts` degrades to `realtime: null`. This endpoint reports what
 * exists; it is not a per-trip result array, so a caller must key by
 * `tripId` rather than by position.
 *
 * Staleness is inherited, not re-implemented: `journeyFor` already answers
 * null once the snapshot is older than `REALTIME_MAX_AGE_SECONDS`.
 *
 * Duplicate ids collapse: a `Set` here rather than a de-dupe of the output,
 * so a trip named twice costs one lookup, not two.
 */
function positionsFor(
  store: RealtimeStore, ix: TimetableIndex, tz: string, tripIds: readonly string[],
): Vehicle[] {
  const vehicles: Vehicle[] = [];
  for (const tripId of new Set(tripIds)) {
    const tripIdx = ix.tripIdToIdx.get(tripId);
    if (tripIdx === undefined) continue;
    const resolved = store.journeyFor(tripIdx);
    if (resolved === null) continue;
    const vehicle = vehicleOf(store, ix, tz, resolved);
    if (vehicle !== null) vehicles.push(vehicle);
  }
  return vehicles;
}

/**
 * Every bus on the road for one route, by scanning the snapshot's journeys
 * for the route's trips. A scan, not a lookup: the caller -- a line's page --
 * has no trip ids for the buses already running, only for runs yet to start.
 * One pass over a few thousand in-memory entries, still no database and no
 * upstream call. An unknown route simply matches nothing.
 */
function routePositions(
  store: RealtimeStore, ix: TimetableIndex, tz: string, routeId: string,
): Vehicle[] {
  const routeIdx = ix.routeIds.indexOf(routeId);
  if (routeIdx === -1) return [];
  const vehicles: Vehicle[] = [];
  for (const resolved of store.journeys()) {
    if (ix.tripRouteIdx[resolved.tripIdx] !== routeIdx) continue;
    const vehicle = vehicleOf(store, ix, tz, resolved);
    if (vehicle !== null) vehicles.push(vehicle);
  }
  return vehicles;
}

/**
 * `GET /vehicles?trips=T1,T2` -- where the vehicles running these trips are
 * right now.
 *
 * Pure map lookups over the snapshot `SiriPoller` already holds in memory:
 * this never fetches from the ministry, never touches the database, and
 * costs the same whether one client is polling it or a thousand are. That
 * is the point -- a map that redraws every 20 seconds must not become a
 * per-request cost.
 *
 * Answers 200 with `vehicles: []` in every "nothing to show" case --
 * realtime disabled, the wrong feed, no index yet, no fresh snapshot,
 * unknown trip -- and reports `source` alongside so a client can tell
 * "this deployment has no live positions at all" from "this trip's bus is
 * not reporting". The gate is entirely server-side: the day an MOT key is
 * configured this starts answering and the dots appear with no client
 * release, the same contract `/meta`'s health already gives the rest of the
 * live-vs-scheduled affordances.
 */
export const vehicleRoutes: FastifyPluginAsync = async (app) => {
  app.get("/vehicles", {
    schema: {
      querystring: { type: "object", properties: { trips: { type: "string" } } },
    },
  }, async (req) => {
    const { trips } = req.query as { trips?: string };

    let tripIds: string[];
    try { tripIds = parseTrips(trips); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }

    const store = app.realtime;
    const source = store === null ? null : store.feedSource;
    const ix = app.index.current();
    if (store === null || ix === null) {
      return { source, vehicles: [] };
    }
    return { source, vehicles: positionsFor(store, ix, config.timezone, tripIds) };
  });

  /**
   * `GET /routes/:routeId/vehicles` -- every bus currently on this route,
   * for the line page's map. Same shape, same freshness gate and the same
   * "200 with an empty list" contract as `/vehicles`; never a 404, because
   * answering one would mean asking the database whether the route exists,
   * and a map polled every 20 seconds must stay a memory read.
   */
  app.get("/routes/:routeId/vehicles", {
    schema: {
      params: { type: "object", required: ["routeId"], properties: { routeId: { type: "string" } } },
    },
  }, async (req) => {
    const { routeId } = req.params as { routeId: string };
    const store = app.realtime;
    const source = store === null ? null : store.feedSource;
    const ix = app.index.current();
    if (store === null || ix === null) {
      return { source, vehicles: [] };
    }
    return { source, vehicles: routePositions(store, ix, config.timezone, routeId) };
  });
};
