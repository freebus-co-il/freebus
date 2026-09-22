import type { FastifyPluginAsync } from "fastify";
import { parseLang, type Lang, type Translator } from "../db/i18n.js";
import { serviceWindow, ymdOf, toIso } from "../transit/calendar.js";
import { buildDayContexts, runRaptor, type RaptorAccess, type DayContext } from "../transit/raptor.js";
import { runRaptorReverse, extraAlightingSeconds } from "../transit/raptorReverse.js";
import {
  paretoRounds, reconstructForward, reconstructReverseChain, buildItinerary,
  hasRidden, hasRiddenReverse,
  type WalkLeg, type Itinerary, type Leg, type TransitLeg, type TransitRide,
} from "../transit/itinerary.js";
import { annotateAlternatives } from "../transit/alternatives.js";
import { shiftsFor } from "../transit/shift.js";
import type { Label } from "../transit/raptor.js";
import type { TimetableIndex } from "../transit/index.js";
import {
  headwayTableFor, headwayFor, patternTravelOffset, requiredTransferSeconds,
  type TransferMargin,
} from "../transit/headway.js";
import { haversineMeters, type LatLon } from "../geo.js";
import {
  walkConfig, config, planConfig, rankConfig, alternativesConfig, routeRateLimits,
} from "../config.js";
import { ApiError } from "../errors.js";
import { WALK_DETOUR_FACTOR } from "../walking/valhalla.js";
import { rankItineraries } from "../transit/rank.js";
import { reoptimiseBounded } from "./reoptimise.js";
import { resolveLegGeometry } from "./legGeometry.js";
import { resolveWalkGeometry } from "./walkGeometry.js";
import { refineAccessByWalking } from "./accessRefine.js";
import type { RealtimeStore } from "../realtime/store.js";

/**
 * Bound on how much earlier than the requested `arriveBy` instant a
 * reconstructed itinerary's own arrival may fall before it is discarded as
 * nonsensical.
 *
 * `buildDayContexts` deliberately includes both the query's own calendar day
 * and the previous one, so a service that departed "yesterday at 25:30" (a
 * real GTFS time past midnight) can still be found for a query issued after
 * that trip's wall-clock arrival. That is necessary and correct. But taken
 * literally, nothing about the reverse search restricts WHICH day's service
 * satisfies the deadline: if today has no usable service at all (e.g. the
 * requested day of week doesn't run it), the previous day's perfectly
 * ordinary, non-wraparound trip can satisfy "arrival <= deadline" just as
 * well -- because any arrival at least a day earlier is trivially <= a
 * same-day-or-later deadline. The result is a journey that "arrives by"
 * the requested time by arriving a full calendar day before it, which is not
 * what a rider asking to arrive by e.g. 08:05 today could mean. 24 hours is
 * the natural bound: the two-day context can produce at most a ~24h-earlier
 * result from the wraparound case this exists to support, so anything
 * beyond that is definitely the unwanted case, not a legitimate late-night
 * trip.
 */
const ARRIVE_BY_MAX_LOOKBACK_SECONDS = 24 * 3600;

/**
 * Bound on the largest single WAIT -- alighting one ride, then standing
 * until the next boarding -- inside an `arriveBy` itinerary, before it is
 * discarded as nonsensical. Gated on the headway-scaled margin actually
 * being enabled (`transfer.cfg.factor !== 0`, see the call site) -- see
 * that gate's own comment for why. ONE-SIDED: `departAfter` has no
 * equivalent check. A `departAfter` itinerary can report a comparably large
 * wait (10.8 h observed, one transfer, on a genuinely sparse route) but that
 * is a legitimate fewest-transfers Pareto member, not a search artefact --
 * `departAfter` explores forward from the query instant and has no
 * unbounded fallback mechanism to reject. See the third bullet below for
 * why `arriveBy` is different.
 *
 * The bound is on the WAIT, not on `itin.durationSeconds`: on the `arriveBy`
 * branch that field is not the journey's actual duration, it is
 * (approximately) "deadline minus door departure" -- a property of the
 * QUESTION asked, not of the journey. A controlled probe (identical origin,
 * destination and a single fixed bus, only the deadline moved) showed
 * `durationSeconds` climbing from ~2h to ~15h as the deadline moved from
 * 07:00 to 20:00, for the exact same ~1h door-to-door ride. A bound on that
 * field, measured against the real feed (`data/gtfs.sqlite`, 300+ OD pairs,
 * generous deadlines), lost an itinerary on 15.9% of pairs and returned
 * nothing at all on 2.8%; of 53 dropped itineraries only 16 had any wait
 * over 8 h -- 37 were ordinary journeys a duration threshold cannot
 * distinguish from the pathology, because a legitimate ~1.4 h journey can
 * read ~15 h on this field while the fixture defect itself reads ~23.4 h. No
 * threshold on `durationSeconds` separates the two populations. (The
 * mechanism: a reverse chain ending in a footpath into the destination
 * reports the DEADLINE, not the real arrival, as `arrivalTime` -- a known,
 * unfixed defect that predates this bound.)
 *
 * The WAIT between two adjacent rides is what actually discriminates: it is
 * computed from each TRANSIT LEG's own `from.departureTime`/`to.
 * arrivalTime` (real, per-leg schedule data the reverse search actually
 * matched -- see `maxTransferWaitSeconds`), never from the itinerary-level
 * `arrivalTime`/`durationSeconds` fields above. `maxTransferWaitSeconds`
 * subtracts the reported (buffer-STRIPPED) `walkSeconds`, not the raw
 * footpath span, so it counts the ~60 s boarding buffer as part of the
 * "wait" it measures -- harmless against a 43200 s bound, noted for
 * precision rather than because it matters here.
 *
 * VALUE, measured (not assumed) against the real feed: waits do not split
 * cleanly into "small legitimate" and "large pathological". The measured
 * band is narrow: the largest wait attributable to a genuine, undominated
 * itinerary is 10.29 h (Mitzpe Ramon -> Netanya, one transfer, confirmed to
 * have no strictly-later same-or-fewer-transfer alternative), and the
 * lowest observed genuine pathology is 12.81 h. Zero of 629 measured
 * itineraries fall between 11 h and 12.8 h. 12 hours sits in that gap -- it
 * is not a generously rounded number, it is the only whole-hour value the
 * evidence actually supports. A 10 h bound would reject the legitimate
 * Mitzpe Ramon journey above.
 *
 * A large wait in a peripheral-stops sample is not necessarily
 * wrong-direction boarding or a held-overnight itinerary: re-probing 50
 * pairs with waits over an hour, by re-querying `departAfter` from each
 * itinerary's own departure + 60 s, found 0 of 50 with a strictly-later
 * same-or-fewer-transfer alternative -- every one is a genuine
 * fewest-transfers Pareto member on a sparse route, not a search defect.
 * Genuine pathology (the kind `ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS` exists
 * to catch) measures at roughly 1 in 300 random OD pairs. A wait that looks
 * like wrong-direction travel is most likely a misreading of this feed's
 * route `longName`, which encodes BOTH pattern endpoints as `X<->Y`
 * regardless of which direction any one trip actually runs, not evidence the
 * bus was headed away from the destination.
 */
const ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS = 12 * 3600;

/**
 * The largest gap between alighting one transit leg and boarding the next,
 * across an itinerary's own legs -- the quantity `runRaptorReverse` never
 * bounds (it only ever checks whether a gap clears the REQUIRED margin, not
 * how large the gap actually is). Walk time inside a transfer is excluded
 * (`walkSeconds` is subtracted): a long walk is not idle waiting, and this
 * function exists to catch the rider being told to STAND somewhere, not to
 * penalise a long transfer walk. (`walkSeconds` is the buffer-STRIPPED
 * figure `itinerary.ts` reports, not the raw footpath span -- see
 * `ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS`'s own comment for why that is
 * harmless here.)
 *
 * Deliberately reuses `computeTransferAtRisk`'s own "walk forward past any
 * intervening walk leg(s) to the next transit leg" loop shape, below --
 * same traversal, different question (magnitude of the gap here, versus
 * whether a live prediction still clears the required margin there).
 */
function maxTransferWaitSeconds(legs: readonly Leg[]): number {
  let maxWait = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg === undefined || leg.type !== "transit") continue;

    let j = i + 1;
    let walkSeconds = 0;
    for (; j < legs.length; j++) {
      const maybeWalk = legs[j];
      if (maybeWalk === undefined || maybeWalk.type !== "walk") break;
      walkSeconds += maybeWalk.durationSeconds;
    }
    const next = legs[j];
    if (next === undefined || next.type !== "transit") continue;

    const arrivalEpoch = Date.parse(leg.to.arrivalTime) / 1000;
    const nextDepartureEpoch = Date.parse(next.from.departureTime) / 1000;
    const wait = nextDepartureEpoch - arrivalEpoch - walkSeconds;
    if (wait > maxWait) maxWait = wait;
  }
  return maxWait;
}

export type ParsedPlace =
  | { kind: "coord"; lat: number; lon: number }
  | { kind: "stop"; stopId: string };

export function parsePlace(raw: string): ParsedPlace {
  if (raw.startsWith("stop:")) {
    const stopId = raw.slice(5);
    if (stopId === "") throw new Error(`Invalid place: ${raw}`);
    return { kind: "stop", stopId };
  }
  const parts = raw.split(",");
  if (parts.length !== 2) throw new Error(`Invalid place: ${raw}`);
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`Invalid place: ${raw}`);
  }
  return { kind: "coord", lat, lon };
}

/**
 * Access or egress stops for one endpoint.
 *
 * A `stop:` endpoint resolves to that stop with zero walking -- the client
 * asked to start there, not near there. A coordinate is matched against every
 * stop within maxWalkMeters straight-line, which is complete for the same
 * reason the footpath prefilter is (straight-line is a lower bound on street
 * distance).
 *
 * The result is de-duplicated by stop index, keeping the smallest
 * `secondsToReach` per stop. A single left-to-right scan over `0..nStops`
 * cannot itself produce two entries for the same stop, but `paretoRounds`
 * only ever returns a `stopIdx` -- if two destination entries ever shared a
 * stop with different walk times, the caller could not tell which egress
 * produced a given arrival (see itinerary.ts's `paretoRounds` doc comment).
 * De-duplicating here, once, before any RAPTOR query ever sees this list, is
 * cheap insurance against that ambiguity ever existing downstream, including
 * for a future caller that merges access lists from more than one source.
 */
export function accessStops(
  ix: TimetableIndex, place: ParsedPlace, maxWalkMeters: number, speedMps: number,
): { stops: RaptorAccess[]; point: LatLon | null } {
  if (place.kind === "stop") {
    const idx = ix.stopIdToIdx.get(place.stopId);
    if (idx === undefined) return { stops: [], point: null };
    return {
      stops: [{ stopIdx: idx, secondsToReach: 0 }],
      point: [ix.stopLat[idx]!, ix.stopLon[idx]!],
    };
  }

  const from: LatLon = [place.lat, place.lon];
  const bySeconds = new Map<number, number>();
  for (let s = 0; s < ix.nStops; s++) {
    const d = haversineMeters(from, [ix.stopLat[s]!, ix.stopLon[s]!]);
    if (d <= maxWalkMeters) {
      const seconds = Math.round((d * WALK_DETOUR_FACTOR) / speedMps);
      const existing = bySeconds.get(s);
      if (existing === undefined || seconds < existing) bySeconds.set(s, seconds);
    }
  }
  const stops: RaptorAccess[] = [...bySeconds].map(([stopIdx, secondsToReach]) =>
    ({ stopIdx, secondsToReach }));
  return { stops, point: from };
}

/**
 * How many nearest-by-crow-flight stops the nearest-stop fallback (below)
 * routes through Valhalla when an endpoint's own `maxWalkMeters` cap leaves
 * it with nothing. One would just reproduce the failure mode the fallback
 * exists to avoid: the single closest stop can sit across a motorway or a
 * rail corridor, with a real walk many times its straight-line distance,
 * while a stop a little further away as the crow flies is a direct, short
 * one. Five candidates cost the SAME one matrix call as the normal path --
 * `refineAccessByWalking` has no per-call candidate cap of its own (see its
 * own doc comment) -- so there is no efficiency reason to keep this at one;
 * it only trades how far past the literal nearest stop the fallback looks.
 * Five gives a rider stranded far from every stop a genuine choice among a
 * handful of nearby options, not just the single nearest one a motorway
 * might sit between them and.
 */
export const NEAREST_STOP_FALLBACK_COUNT = 5;

/**
 * The `n` nearest stops to `point` by straight-line distance, ignoring
 * `maxWalkMeters` entirely -- the fallback candidate set for an endpoint
 * `accessStops`/`refineAccessByWalking` left with nothing (see the route
 * handler's own fallback block, below, for when this runs).
 *
 * Seeds each candidate's `secondsToReach` with the same straight-line
 * estimate `accessStops` uses (haversine, scaled by `WALK_DETOUR_FACTOR` and
 * `speedMps`), for the same reason: the caller always routes this list
 * through `refineAccessByWalking` immediately afterward, which replaces the
 * estimate with a real duration on success -- but on Valhalla's own degrade
 * path (down, timed out, malformed response) the candidates come back
 * UNTOUCHED, and the estimate computed here is what survives into the
 * response instead of nothing at all.
 *
 * No de-duplication needed, unlike `accessStops`: this scans stop index
 * `0..ix.nStops` once, so it cannot produce two entries for the same
 * physical stop the way `accessStops` defensively guards against for its
 * own, differently-derived candidate set (see that function's own doc
 * comment).
 */
export function nearestStops(
  ix: TimetableIndex, point: LatLon, n: number, speedMps: number,
): RaptorAccess[] {
  // A bounded top-n insertion scan, not "push everything, sort, slice": `n`
  // is always small (the fallback's own `NEAREST_STOP_FALLBACK_COUNT`, 5),
  // so keeping only the best `n` seen so far -- with no per-stop object
  // allocation, unlike `accessStops` above needing a `Map` for de-dup this
  // function does not -- costs O(nStops * n) with a tiny constant, against a
  // full sort's O(nStops log nStops) plus one allocated object per stop.
  // Measured against this feed's 35,266 stops: 0.59 ms here vs 9.68 ms for a
  // full sort-and-slice version -- both endpoints falling back would
  // otherwise add ~19 ms to a request that already blocks the event loop
  // 50-200 ms on this service's 2-vCPU box.
  const bestIdx: number[] = [];
  const bestDist: number[] = [];
  for (let s = 0; s < ix.nStops; s++) {
    const d = haversineMeters(point, [ix.stopLat[s]!, ix.stopLon[s]!]);
    // `bestIdx.length >= n` (the only way past the first disjunct) means
    // `n >= 1` and the array is already full, so index `bestIdx.length - 1`
    // -- its worst (largest-distance) entry -- is in bounds.
    if (bestIdx.length < n || d < bestDist[bestIdx.length - 1]!) {
      let i = bestIdx.length;
      // `i > 0` is checked first, so `bestDist[i - 1]` is only ever read
      // in-bounds.
      while (i > 0 && bestDist[i - 1]! > d) i--;
      bestIdx.splice(i, 0, s);
      bestDist.splice(i, 0, d);
      if (bestIdx.length > n) { bestIdx.pop(); bestDist.pop(); }
    }
  }
  // Parallel arrays built together above, index for index, so `bestDist[i]`
  // is defined for every `i` in `bestIdx`'s own range.
  return bestIdx.map((stopIdx, i) => ({
    stopIdx,
    secondsToReach: Math.round((bestDist[i]! * WALK_DETOUR_FACTOR) / speedMps),
  }));
}

/**
 * `?modes=` -> a set of GTFS `route_type` values.
 *
 * Validated rather than coerced, because `Number` is far too forgiving for a
 * filter that decides which vehicles a journey may use:
 *
 *  - `Number("")` is `0`, so a bare `modes=` would coerce to "tram only" — a
 *    query that looks like "no filter" silently answering as the narrowest
 *    possible filter.
 *  - `Number("abc")` is `NaN`; filtering those out with `.filter(Number.
 *    isFinite)` would leave `modes=abc` an EMPTY mode set and a `200` with
 *    zero itineraries: a typo indistinguishable from "genuinely
 *    unreachable", which is the exact failure mode `/plan`'s 422s exist to
 *    prevent elsewhere.
 *
 * Anything that is not a comma-separated list of integers is now a 400
 * naming the offending value. Whitespace around an entry is tolerated
 * (`modes=0, 3` survives a URL-decoded space); an empty entry is not,
 * since `modes=0,,3` is a mistake, not a mode.
 */
export function parseModes(raw: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid modes value: "${part}". `
        + "modes must be a comma-separated list of integer GTFS route_type "
        + "values, e.g. modes=0,3. Omit the parameter entirely for no filter.",
      );
    }
    out.add(Number(trimmed));
  }
  return out;
}

/**
 * One transit leg's realtime annotation, or null when this leg's trip has no
 * fresh, resolved data. `RealtimeStore.journeyFor` already collapses
 * "disabled", "stale" and "never matched by SIRI" into that single `null`
 * (see its own doc comment) -- this function does not need to re-derive any
 * of the three, it only needs to check the one method.
 *
 * SIRI gives us exactly one predicted instant per stop call
 * (`ExpectedArrivalTime` -- see `RealtimeCall`), which `RealtimeStore`
 * therefore stores and returns as an ARRIVAL, at every stop including the
 * board stop. `predictedDeparture` is never that raw value: it is DERIVED,
 * by computing the delay at the board stop from arrival against that same
 * stop's own SCHEDULED arrival, then applying that delay to the scheduled
 * departure (`leg.from.departureTime`) -- the way GTFS-RT itself separates
 * arrival and departure delay per stop_time. On this feed, which dwells
 * nowhere (`arrival_time === departure_time` on all 9.8M `stop_times` rows,
 * checked 2026-08-23), the derived value is numerically identical to the
 * raw prediction; treating it as an arrival by construction rather than by
 * this feed's current behaviour is what keeps it correct the day a feed
 * with real dwell arrives. `predictedArrival` on the leg's OWN alight stop
 * needs no such derivation -- SIRI's arrival prediction there already
 * answers the exact question being asked.
 *
 * Never throws: a `tripId`/stop-id lookup miss (should not happen, since
 * every id here came from this same `ix`) degrades to an absent prediction
 * rather than a fault -- annotation may enrich a response, never fail one.
 */
function realtimeForLeg(
  realtime: RealtimeStore, ix: TimetableIndex, tz: string, leg: TransitRide,
): TransitLeg["realtime"] {
  const tripIdx = ix.tripIdToIdx.get(leg.tripId);
  if (tripIdx === undefined) return null;
  const journey = realtime.journeyFor(tripIdx);
  if (journey === null) return null;

  // `!`: a TransitLeg's own endpoints are always built by `placeOfStop`
  // (transit/itinerary.ts), which always sets `stopId` -- `Place.stopId` is
  // optional only because a WalkLeg's endpoint can be a bare coordinate.
  const boardStopIdx = ix.stopIdToIdx.get(leg.from.stop.stopId!);
  const alightStopIdx = ix.stopIdToIdx.get(leg.to.stop.stopId!);
  // `unambiguousPredictionFor`, not `predictionFor`: this leg boards/alights
  // at one SPECIFIC pattern position, and a stop this trip's pattern visits
  // more than once (a loop) cannot be trusted to belong to that exact visit
  // -- see `RealtimeStore.unambiguousPredictionFor`'s own doc comment. The
  // departures board (routes/departures.ts) has no such position to
  // disambiguate against and keeps using `predictionFor` unchanged.
  const predictedArrivalAtBoardEpoch =
    boardStopIdx === undefined ? null : realtime.unambiguousPredictionFor(tripIdx, boardStopIdx);
  const predictedArrivalEpoch =
    alightStopIdx === undefined ? null : realtime.unambiguousPredictionFor(tripIdx, alightStopIdx);

  // Re-derived from the leg's own ISO strings rather than threaded through
  // as separate epochs -- toIso/Date.parse round-trip exactly, the same
  // pattern this route handler already uses for the arriveBy lookback check
  // further down.
  //
  // The SCHEDULED pair, not `from.departureTime`/`to.arrivalTime`: since
  // realtime re-planning, those two carry the PREDICTED instants whenever this
  // trip was shifted into the search. Measuring a delay against a time that
  // already includes the delay reports only the residual, not the true delay
  // (e.g. 90 s reported for an actual 300 s delay). Everything below is
  // delay arithmetic and needs the timetable as its fixed point.
  const scheduledDepartureEpoch = Date.parse(leg.from.scheduledDepartureTime) / 1000;
  const scheduledArrivalEpoch = Date.parse(leg.to.scheduledArrivalTime) / 1000;

  // The board stop's own SCHEDULED arrival, read straight off the index at
  // this leg's exact pattern position -- `boardPos` is the pattern position
  // `buildItinerary` stored on this exact leg as `stopSequence` (see
  // itinerary.ts), so `timeFrom + boardPos` indexes the one specific
  // `stop_times`-equivalent row this leg actually boarded at: not a
  // database round-trip, and not ambiguous even on a loop pattern that
  // revisits a physical stop, because this is a POSITION, not a stop id or
  // a lookup by one.
  const timeFrom = ix.tripTimeOffset[tripIdx]!;
  const boardPos = leg.from.stopSequence;
  // The service day's own baseEpoch, recovered from this leg's already-known
  // departure instant rather than threaded through as a parameter: `leg.
  // from.departureTime`'s epoch equals `baseEpoch + ix.departureTime[timeFrom
  // + boardPos]` by construction (see `buildItinerary`/`earliestTripOnDay`),
  // so subtracting the latter recovers the former exactly.
  const baseEpoch = scheduledDepartureEpoch - ix.departureTime[timeFrom + boardPos]!;
  const scheduledArrivalAtBoardEpoch = baseEpoch + ix.arrivalTime[timeFrom + boardPos]!;

  const boardDelaySeconds = predictedArrivalAtBoardEpoch === null
    ? null : predictedArrivalAtBoardEpoch - scheduledArrivalAtBoardEpoch;
  const predictedDepartureEpoch = boardDelaySeconds === null
    ? null : scheduledDepartureEpoch + boardDelaySeconds;

  return {
    predictedDeparture:
      predictedDepartureEpoch === null ? null : toIso(predictedDepartureEpoch, tz),
    predictedArrival:
      predictedArrivalEpoch === null ? null : toIso(predictedArrivalEpoch, tz),
    // Anchored on the ALIGHT stop's arrival, deliberately: this is the
    // instant that decides whether the next connection is made, which is
    // what a consumer reading a single "delay" number on a leg actually
    // wants to know. Not the board-stop delay computed above, which exists
    // only to derive `predictedDeparture`.
    delaySeconds:
      predictedArrivalEpoch === null ? null : predictedArrivalEpoch - scheduledArrivalEpoch,
    vehicleRef: journey.journey.vehicleRef,
    confidence: journey.journey.confidence,
    recordedAt:
      journey.journey.recordedAt === null ? null : toIso(journey.journey.recordedAt, tz),
    source: realtime.feedSource,
  };
}

/**
 * The margin the search that actually built this itinerary would have
 * required to board `next` -- recomputed here from the itinerary's own
 * SCHEDULED times because neither `Label` nor `TransitLeg` carries the
 * margin that search charged.
 *
 * `reverseSourced` selects WHICH rule: a plain `departAfter` itinerary
 * (`reverseSourced: false`) was built by the FORWARD pass (`raptor.ts`),
 * which charges the pointwise `requiredTransferSeconds` at the exact
 * candidate boarding instant. An `arriveBy` itinerary, or a `departAfter`
 * one `reoptimise.ts` swapped onto a reverse-pass chain (`reverseSourced:
 * true` either way -- see the route handler's own `reverseSourced` array),
 * was built by the REVERSE pass (`raptorReverse.ts`), which cannot read the
 * boarding hour it is solving for and so charges the MAXIMUM required
 * margin over its whole readiness window instead --
 * `extraAlightingSeconds`, imported rather than re-derived here, so the two
 * copies of this rule cannot drift the way a duplicated invariant always
 * eventually does. Using the forward rule unconditionally for both cases
 * would look "safe" on the theory that the forward value is always an
 * under-estimate -- that reasoning is backwards: a SMALLER `required` makes
 * `computeTransferAtRisk`'s `predicted + walk + required > departure` check
 * LESS likely to fire, which is the PERMISSIVE direction, not the safe one.
 * Confirmed case: an `arriveBy` itinerary reported `transferAtRisk: false`
 * for a connection the reverse pass required 600 s for, with only 120 s of
 * real slack left after a ten-minute predicted delay.
 *
 * Mirrors `raptor.ts`'s `base` exactly, for the `reverseSourced: false`
 * path: `prevArrivalEpoch` is the alighting leg's SCHEDULED arrival (never
 * the predicted one -- RAPTOR never sees realtime, so the margin it charged
 * was always measured against schedule), `walkSeconds` is the reported
 * (buffer-ALREADY-stripped -- see `itinerary.ts`'s `buildItinerary`)
 * duration of any intervening walk leg, and adding `cfg.baseSeconds`
 * restores the same candidate boarding instant `raptor.ts` calls `base`
 * whether or not a walk leg exists: a same-stop transfer folds the buffer
 * in here (mirroring `label.kind === "transit"` charging
 * `transferMinSeconds` directly), and a footpath transfer's `walkSeconds`
 * is already the buffer-exclusive figure, so adding it back once here
 * reconstructs the buffer-inclusive raw span either way. The
 * `reverseSourced: true` path needs no candidate-instant reconstruction at
 * all -- `extraAlightingSeconds` only wants `next`'s own real departure
 * epoch, which is already in hand.
 *
 * The service day is recovered from `next`'s own boarding position exactly
 * as this file's `realtimeForLeg` already does for the identical problem
 * (no `dayIdx` survives onto a `TransitLeg`): `next`'s scheduled
 * departure epoch minus the index's own stored offset for that exact
 * pattern position recovers the trip's `baseEpoch` exactly, which is matched
 * against `days` to find the table this trip was actually searched under --
 * needed by BOTH paths alike, since `extraAlightingSeconds` also indexes
 * `transfer.headway` by `dayIdx`.
 *
 * Defensive, not strict, on a lookup miss (unknown trip id, or a baseEpoch
 * matching neither `DayContext`) -- both should be impossible, since every
 * id and every trip here came from this same itinerary, itself built from
 * this same `ix`/`days`. But this function feeds an ANNOTATION
 * (`transferAtRisk`), not the search: like `realtimeForLeg`, it may enrich a
 * response, never fail one, so a lookup miss degrades to `cfg.baseSeconds`
 * -- the flat rule -- rather than throwing and 500ing an otherwise-valid
 * response. `runRaptor`/`runRaptorReverse` are where a contract violation
 * must throw loudly (`validateTransferContract`); this is a read-only
 * re-derivation after the fact, where the strict-refusal philosophy does
 * not apply.
 *
 * `next` only ever needs to be a full `TransitLeg` for the three fields
 * named on `MarginBoardingLeg`, below -- narrowed to exactly those (rather
 * than the full type) so a caller that has not built a real `TransitLeg` at
 * all (`routes/journeyCheck.ts`, which works from a rider-supplied
 * trip/stop triple with no itinerary around it) can still call this
 * function itself instead of copying its logic. `TransitLeg` still
 * satisfies this interface structurally, so every existing caller here is
 * unaffected.
 */
export interface MarginBoardingLeg {
  tripId: string;
  from: { stopSequence: number; departureTime: string };
}

export function requiredMarginFor(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean,
  prevArrivalEpoch: number, walkSeconds: number, next: MarginBoardingLeg,
): number {
  const nextTripIdx = ix.tripIdToIdx.get(next.tripId);
  if (nextTripIdx === undefined) return transfer.cfg.baseSeconds;

  // `nextTripIdx` just came back from `tripIdToIdx`, which `buildIndex`
  // sizes `tripTimeOffset` (length `nTrips + 1`) to cover for every valid
  // trip index -- the same invariant `realtimeForLeg` above relies on for
  // its own `timeFrom` lookup.
  const timeFrom = ix.tripTimeOffset[nextTripIdx]!;
  const boardPos = next.from.stopSequence;
  const nextScheduledDepartureEpoch = Date.parse(next.from.departureTime) / 1000;
  // `boardPos` is the pattern position `buildItinerary` stored as this
  // exact leg's `stopSequence`, so `timeFrom + boardPos` indexes a real row
  // of this trip's times -- the identical reasoning `realtimeForLeg` above
  // documents at length for its own `timeFrom + boardPos` lookups.
  const tripBaseEpoch = nextScheduledDepartureEpoch - ix.departureTime[timeFrom + boardPos]!;

  const dayIdx = days.findIndex((d) => d.baseEpoch === tripBaseEpoch);
  if (dayIdx === -1) return transfer.cfg.baseSeconds;

  // `nextTripIdx` is a valid trip index (checked above), and `patternOfTrip`
  // is sized to `nTrips` by `patterns.ts` -- every trip belongs to exactly
  // one pattern.
  const patternIdx = ix.patternOfTrip[nextTripIdx]!;

  if (reverseSourced) {
    // `dayIdx` is a real index into `days`, and `transfer.headway` is
    // validated elsewhere (`validateTransferContract`, run inside
    // `runRaptor`/`runRaptorReverse` for the SAME `transfer` object this
    // request built) to be exactly parallel to `days` -- the same
    // in-bounds argument `extraAlightingSeconds` itself relies on.
    return transfer.cfg.baseSeconds
      + extraAlightingSeconds(
        ix, transfer, days, patternIdx, boardPos, dayIdx, nextScheduledDepartureEpoch,
      );
  }

  const base = prevArrivalEpoch + walkSeconds + transfer.cfg.baseSeconds;
  const secondsIntoDay = base - tripBaseEpoch;

  // `dayIdx` is a real index into `days` (found via `findIndex` above, with
  // the `-1` case already returned), and `transfer.headway` is validated
  // elsewhere (`validateTransferContract`, run inside `runRaptor`/
  // `runRaptorReverse` for the SAME `transfer` object this request built)
  // to be exactly parallel to `days` -- so `transfer.headway[dayIdx]` is in
  // bounds whenever `days[dayIdx]` is.
  // Shifted back to first-stop time exactly as `raptor.ts`'s own boarding
  // check does, using the same `boardPos` this function already recovered
  // the service day from: the headway table is keyed on the hour of a
  // pattern's departure from its FIRST stop, not from wherever this rider
  // boards it. `extraAlightingSeconds` above applies the identical shift on
  // the reverse path, inside itself.
  return requiredTransferSeconds(
    headwayFor(
      transfer.headway[dayIdx]!, patternIdx,
      secondsIntoDay - patternTravelOffset(ix, patternIdx, boardPos),
    ),
    transfer.cfg,
  );
}

/**
 * Every interchange in an itinerary: a transit leg, the next transit leg,
 * and the walking seconds between them (0 for a same-stop transfer, since
 * `raptor.ts` boards one directly with no walk leg). An itinerary's last
 * ride has no next transit leg and so contributes no pair.
 *
 * Extracted because two callers need exactly this walk and must not drift:
 * `scheduledTransferAtRisk` (schedule only, always runs) and
 * `computeTransferAtRisk` (schedule plus realtime, runs only when a store is
 * configured). A second hand-rolled copy of the "skip forward past the walk
 * legs" loop is precisely the kind of duplicated invariant this file's
 * `validateTransferContract` comment warns about.
 */
function transferPairs(legs: readonly Leg[]): {
  leg: TransitLeg; next: TransitLeg; walkSeconds: number;
}[] {
  const out: { leg: TransitLeg; next: TransitLeg; walkSeconds: number }[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg === undefined || leg.type !== "transit") continue;

    let j = i + 1;
    let walkSeconds = 0;
    for (; j < legs.length; j++) {
      const maybeWalk = legs[j];
      if (maybeWalk === undefined || maybeWalk.type !== "walk") break;
      walkSeconds += maybeWalk.durationSeconds;
    }
    const next = legs[j];
    if (next === undefined || next.type !== "transit") continue;
    out.push({ leg, next, walkSeconds });
  }
  return out;
}

/**
 * True when some transfer's SCHEDULED slack -- next departure minus this
 * leg's scheduled arrival minus the walk between them -- is below the margin
 * the rule requires. No realtime involved, and none needed: this is a
 * statement about the timetable alone.
 *
 * Under the ordinary rule this can never fire, because the margin is exactly
 * what the search enforced before it built the connection. It fires on the
 * last-service fallback: at the last service of the day the planner deliberately
 * yields to the flat `baseSeconds` and returns a journey the scaled margin
 * would have refused, because the alternative is no journey at all for
 * someone standing at a stop at 22:15. That trade is only honest if the rider
 * is TOLD, so `transferAtRisk` becomes `true` there whether or not a realtime
 * feed exists -- which is why this runs on every request, while
 * `annotateRealtime` runs only when a store is configured.
 *
 * It never lowers the flag: `annotateTransferRisk` only ever upgrades to
 * `true`, so an itinerary whose realtime status is genuinely unknown keeps
 * its `null` rather than being asserted safe.
 */
function scheduledTransferAtRisk(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean,
  legs: readonly Leg[],
): boolean {
  return transferPairs(legs).some(
    (pair) => marginShortfall(ix, days, transfer, reverseSourced, pair).scheduledShort,
  );
}

/**
 * One transfer, priced: the margin the rule requires of it, and whether the
 * SCHEDULE alone already falls short of that (the last-service fallback).
 * One function so
 * `scheduledTransferAtRisk` and `computeTransferAtRisk` cannot state the same
 * inequality two different ways -- `required` is the value both of them go on
 * to compare a realtime prediction (or the timetable) against.
 */
function marginShortfall(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean,
  pair: { leg: TransitLeg; next: TransitLeg; walkSeconds: number },
): { required: number; scheduledShort: boolean; nextDepartureEpoch: number } {
  // Both SCHEDULED, so this stays the statement about the timetable alone that
  // `scheduledTransferAtRisk`'s own doc comment promises -- unchanged in
  // meaning now that a leg's `departureTime`/`arrivalTime` may be predicted.
  const scheduledArrivalEpoch = Date.parse(pair.leg.to.scheduledArrivalTime) / 1000;
  const nextDepartureEpoch = Date.parse(pair.next.from.scheduledDepartureTime) / 1000;
  const required = requiredMarginFor(
    ix, days, transfer, reverseSourced, scheduledArrivalEpoch, pair.walkSeconds, pair.next,
  );
  return {
    required,
    nextDepartureEpoch,
    scheduledShort:
      scheduledArrivalEpoch + pair.walkSeconds + required > nextDepartureEpoch,
  };
}

/**
 * True when some transfer's predicted arrival, plus the following walk (0
 * when the transfer is at the same stop, since `raptor.ts` boards a
 * same-stop transfer directly with no walk leg -- see its main loop's
 * `ready = label.arrivalEpoch + transferMinSeconds`) and the headway-scaled
 * margin `requiredMarginFor` computes -- not the flat `transferMinSeconds`
 * -- lands after the next leg's scheduled departure. `false` must never be
 * laxer than the search that actually produced the itinerary: a predicted
 * arrival five seconds ahead of the next departure is not a safe transfer
 * just because it is not yet a missed one, if the plan itself would have
 * refused to build a connection with under that margin.
 *
 * `reverseSourced` (one flag per itinerary, not per transfer -- the whole
 * itinerary was built by one pass or the other) selects which of the two
 * passes' rules `requiredMarginFor` compares against; see its own doc
 * comment for why getting this wrong is a real defect, not a rounding
 * error, and for the reproduced case that found it.
 *
 * False when every transfer's data confirms the connection holds with that
 * margin intact -- including the trivial case of no transfer at all, an
 * itinerary with a single transit leg. Null when at least one transfer's
 * status cannot be determined and none is confirmed at risk: collapsing
 * that into `false` would assert a safety this function cannot support.
 */
function computeTransferAtRisk(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean,
  legs: readonly Leg[],
): boolean | null {
  let anyAtRisk = false;
  let anyUnknown = false;

  for (const pair of transferPairs(legs)) {
    const { leg, walkSeconds } = pair;
    const { required, scheduledShort, nextDepartureEpoch } =
      marginShortfall(ix, days, transfer, reverseSourced, pair);
    // The schedule alone can already condemn this connection -- the
    // last-service fallback (see `scheduledTransferAtRisk`) -- and when it does, no
    // prediction can rescue it: a vehicle running EARLY is not something
    // this planner will ever promise. Checked before the realtime lookup so
    // the verdict does not depend on whether a feed happens to be
    // configured.
    if (scheduledShort) {
      anyAtRisk = true;
      continue;
    }
    if (leg.realtime === null || leg.realtime.predictedArrival === null) {
      anyUnknown = true;
      continue;
    }
    const predictedArrivalEpoch = Date.parse(leg.realtime.predictedArrival) / 1000;
    if (predictedArrivalEpoch + walkSeconds + required > nextDepartureEpoch) {
      anyAtRisk = true;
    }
  }

  if (anyAtRisk) return true;
  if (anyUnknown) return null;
  return false;
}

/**
 * Raises `transferAtRisk` to `true` on every itinerary holding a transfer
 * the SCHEDULE alone cannot support -- the last-service fallback, where the
 * planner returns a journey the headway-scaled margin would have
 * refused because refusing it returns nothing at all.
 *
 * Runs on EVERY request, unlike `annotateRealtime`, which runs only when a
 * SIRI store is configured (which, until a MOT key arrives, is never). A
 * yielded connection is a fact about the timetable, so a rider must be told
 * about it whether or not live data exists.
 *
 * Only ever raises the flag, never lowers it. Left alone, an itinerary keeps
 * whatever `annotateRealtime` decided, or the pessimistic `null` default
 * `buildItinerary` gives it -- turning that `null` into `false` here would
 * assert a safety no schedule can support, which is exactly the distinction
 * `computeTransferAtRisk`'s own doc comment protects.
 */
export function annotateTransferRisk(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: readonly boolean[],
  itineraries: readonly Itinerary[],
): void {
  itineraries.forEach((itinerary, i) => {
    if (itinerary.transferAtRisk === true) return;
    // `reverseSourced` is built index-for-index alongside `itineraries` at
    // both push sites in the route handler below; the `?? false` is a
    // defensive floor only, never an expected path.
    if (scheduledTransferAtRisk(ix, days, transfer, reverseSourced[i] ?? false, itinerary.legs)) {
      itinerary.transferAtRisk = true;
    }
  });
}

/**
 * Annotates itineraries with live SIRI predictions, in place -- mirrors
 * `resolveLegGeometry`/`resolveWalkGeometry`: it may enrich a response,
 * never fail one, and it never touches `departureTime`/`arrivalTime`.
 * RAPTOR planned with those, and the itinerary's own totals were derived
 * from them -- replacing them here would make the legs stop adding up to
 * the journey, the same reasoning `resolveWalkGeometry` documents for
 * `durationSeconds`. RAPTOR itself never sees this data: it searches the
 * timetable without it, and this runs only after the itineraries it
 * returned are already final.
 *
 * `reverseSourced` is exactly parallel to `itineraries` -- see the route
 * handler's own `reverseSourced` array for how each entry is derived.
 *
 * Only called when `app.realtime !== null` -- see the call site. Every leg
 * and itinerary already carries its pessimistic `realtime: null` /
 * `transferAtRisk: null` default straight from `buildItinerary`, so the
 * disabled path (the default, until a MOT key arrives) needs no call here
 * at all: no lookup is done, and nothing in this file iterates the response
 * a second time for nothing.
 */
export function annotateRealtime(
  realtime: RealtimeStore, ix: TimetableIndex, tz: string, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: readonly boolean[],
  itineraries: readonly Itinerary[],
): void {
  itineraries.forEach((itinerary, i) => {
    for (const leg of itinerary.legs) {
      if (leg.type !== "transit") continue;
      leg.realtime = realtimeForLeg(realtime, ix, tz, leg);
      for (const alternative of leg.alternatives) {
        alternative.realtime = realtimeForLeg(realtime, ix, tz, alternative);
      }
    }
    // `reverseSourced` is built index-for-index alongside `itineraries` at
    // both push sites in the route handler below, so `reverseSourced[i]` is
    // always defined here; the `?? false` is a defensive floor only, never
    // an expected path.
    itinerary.transferAtRisk =
      computeTransferAtRisk(ix, days, transfer, reverseSourced[i] ?? false, itinerary.legs);
  });
}

/**
 * One access or egress walk leg, between a traveller's own coordinate and a
 * stop -- or `undefined` when there is nothing to walk (a `stop:` endpoint,
 * or any endpoint whose access time is zero).
 *
 * `refined` reflects the DURATION's provenance, not the distance's (see the
 * `originRefined`/`targetRefined` comment in the route handler):
 * `walkEstimated` is `false` only when `seconds` is a real Valhalla-measured
 * duration, `true` whenever it is still the 1.33 m/s estimate `accessStops`
 * produced. `distanceMeters` here STARTS as the haversine estimate --
 * `refineAccessByWalking`'s real distance does not currently survive on
 * `RaptorAccess` for this leg to report -- but it is frequently overwritten
 * later in the same request by `resolveWalkGeometry`
 * (routes/walkGeometry.ts), once the itinerary is built, with a real routed
 * distance from its own `/route` call. It is not the final value a client
 * sees whenever that later call succeeds.
 *
 * Module-level, and exported, rather than a closure inside the `/plan`
 * handler, so `routes/planOnboard.ts` builds its egress leg with THIS
 * function instead of a second copy of the same eleven fields -- the walk
 * leg a client reads must not depend on which endpoint answered.
 */
export function buildWalkLeg(
  ix: TimetableIndex, tr: Translator, lang: Lang,
  point: LatLon | null, stopIdx: number, seconds: number, outbound: boolean,
  refined: boolean,
): WalkLeg | undefined {
  if (point === null || seconds === 0) return undefined;
  const stopPlace = {
    type: "stop" as const, lat: ix.stopLat[stopIdx]!, lon: ix.stopLon[stopIdx]!,
    stopId: ix.stopIds[stopIdx]!,
    name: tr.resolve(ix.stopNames[stopIdx] ?? null, lang),
  };
  const coordPlace = { type: "coordinate" as const, lat: point[0], lon: point[1] };
  return {
    type: "walk",
    from: outbound ? coordPlace : stopPlace,
    to: outbound ? stopPlace : coordPlace,
    distanceMeters: Math.round(
      haversineMeters(point, [ix.stopLat[stopIdx]!, ix.stopLon[stopIdx]!])
        * WALK_DETOUR_FACTOR,
    ),
    durationSeconds: seconds,
    geometry: null,
    walkEstimated: !refined,
  };
}

export const planRoutes: FastifyPluginAsync = async (app) => {
  app.get("/plan", {
    schema: {
      // NOTE: deliberately no `response` schema. fast-json-stringify (what
      // Fastify uses to serialize a declared `response` schema) drops any
      // field not explicitly listed in `properties` -- it is a stripping
      // serializer, not a validator with additionalProperties defaulting to
      // allowed. `Itinerary`/`Leg` are a deep, union-shaped (WalkLeg |
      // TransitLeg) structure defined in transit/itinerary.ts; partially
      // listing it here would silently truncate real response fields
      // (durationSeconds, legs, ...) exactly the way an incomplete
      // response schema bit a much smaller endpoint elsewhere in this
      // project. Every other data route in this codebase (lines, stops,
      // departures, meta) makes the same choice for the same reason; only
      // /health, whose whole body is two scalars, declares one.
      //
      // Door-to-door semantics (documented here since there is no response
      // schema to attach it to): `departureTime`/`arrivalTime` on an
      // itinerary are anchored on the START and END OF THE WHOLE CHAIN,
      // including any leading/trailing walk (access/egress) leg -- not on
      // the first/last TRANSIT leg. A `WalkLeg` carries no timestamps of
      // its own, so this is the only place a client can read when the
      // chain begins or ends. These values will differ from
      // `legs[0].from.departureTime` (which exists only when `legs[0]` is a
      // transit leg) whenever the itinerary begins or ends with a walk --
      // callers must not assume the two match.
      //
      // `departureTime` IS the latest feasible door departure in BOTH modes,
      // not just `arriveBy`. The raw forward-RAPTOR chain reports the bare
      // query instant (a 03:00 query answered by an 08:00 bus would report
      // `departureTime: 03:00`, with the five-hour wait folded into
      // `durationSeconds`), but the response never does: after the forward
      // search finds an itinerary, the handler re-anchors its departure on
      // the first
      // transit leg's own boarding time (less any walk before it -- see
      // `reoptimise.ts`'s `reanchorDeparture`), then runs the existing
      // reverse pass backwards from that SAME arrival to check whether an
      // even later departure reaches it with the SAME transfer count (see
      // `reoptimiseItinerary`). `arriveBy` already worked this way, since
      // the reverse search maximises departure directly.
      description:
        "Plans a journey between `from` and `to` (each `lat,lon` or " +
        "`stop:<id>`), given exactly one of `departAfter`/`arriveBy`. " +
        "`departureTime`/`arrivalTime` on each itinerary are door-to-door: " +
        "anchored on the whole chain including any walking access/egress " +
        "leg, not on the first/last transit leg -- a WalkLeg carries no " +
        "timestamp of its own, so they will differ from " +
        "`legs[0].from.departureTime` whenever the itinerary starts or " +
        "ends with a walk. `departureTime` is the LATEST FEASIBLE DOOR " +
        "DEPARTURE that still reaches the reported `arrivalTime` in " +
        "exactly as many transfers, in both modes: with `arriveBy` because " +
        "the reverse search maximises departure directly, and with " +
        "`departAfter` because the forward search's own chain is " +
        "re-anchored on its first boarding and then re-optimised the same " +
        "way (that second refinement runs for the first few itineraries " +
        "only, for latency; the re-anchoring runs for every one, so no " +
        "itinerary ever reports the query instant). " +
        "WHEN LIVE DATA IS AVAILABLE THE SEARCH RUNS ON IT: a trip with a " +
        "realtime delay is planned at its PREDICTED times, so a bus whose " +
        "scheduled departure has already passed but which is running late " +
        "can still be boarded, and a connection the live data refuses is " +
        "not offered. Every transit leg therefore carries BOTH " +
        "`from.departureTime`/`to.arrivalTime` (what the planner used, and " +
        "what a rider should act on -- predicted when this trip was " +
        "delayed) and `from.scheduledDepartureTime`/" +
        "`to.scheduledArrivalTime` (always the published timetable, always " +
        "present, equal to the former when nothing was delayed). " +
        "`realtime.delaySeconds` is measured against the SCHEDULED pair. " +
        "If live delays would leave a query with NO journey at all, the " +
        "planner yields back to the timetable and returns the scheduled " +
        "journey flagged through `transferAtRisk` rather than an empty " +
        "result -- the same rule applies to the last service of the day. " +
        "`arrivalTime` is the real door arrival in both modes, and " +
        "for `departAfter` it is always the EARLIEST reachable arrival -- " +
        "re-optimisation only ever moves `departureTime` later, never " +
        "`arrivalTime`. A transit leg's `geometry` is a precision-6 " +
        "encoded polyline sliced from the operator's own shape between " +
        "the leg's board and alight stops; `geometryFallback: true` means " +
        "the line is a straight line through the leg's stops instead, " +
        "because the trip carries no shape, its shape row is missing, or " +
        "the shape could not be cut to this leg. IN PRACTICE EVERY RAIL " +
        "LEG IS A STRAIGHT LINE: all 1,085 route_type 2 trips in this " +
        "feed -- 100% of them -- carry no shape_id. `geometryFallback` is " +
        "a TRANSIT-LEG FIELD ONLY; it is absent (undefined) on walk legs. " +
        "A walk leg's `geometry` is routed through Valhalla per request " +
        "after the itinerary is built, and becomes a real precision-6 " +
        "encoded polyline whenever that call succeeds; it stays " +
        "`geometry: null` (with a haversine x1.35 `distanceMeters` " +
        "estimate) only when that call failed, timed out, or did not " +
        "parse. A walk leg's `walkEstimated` is unrelated: it describes " +
        "`durationSeconds`'s provenance, not `geometry`'s, and is set " +
        "independently -- see this service's README.",
      querystring: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          departAfter: { type: "string" },
          arriveBy: { type: "string" },
          maxWalkMeters: { type: "integer", minimum: 1, maximum: 2500 },
          maxTransfers: { type: "integer", minimum: 0, maximum: 6, default: 4 },
          results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          modes: { type: "string" },
          wheelchair: { type: "boolean", default: false },
          lang: { type: "string" },
        },
      },
    },
    // Deliberately overrides the global 300/min limit DOWNWARD for this
    // route only -- `/plan` runs a RAPTOR search per request and is the
    // expensive endpoint on this box; see `routeRateLimits.planPerMinute`
    // in `../config.js` for why this figure specifically. `@fastify/
    // rate-limit` reads per-route settings from `config.rateLimit` because
    // the plugin is registered globally in `server.ts`.
    config: { rateLimit: { max: routeRateLimits.planPerMinute, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const q = req.query as {
      from: string; to: string; departAfter?: string; arriveBy?: string;
      maxWalkMeters?: number; maxTransfers: number; results: number;
      modes?: string; wheelchair: boolean; lang?: string;
    };

    const ix = app.index.current();
    if (ix === null) {
      // A deliberate, retryable 503 -- not a fault -- so it carries its own
      // code and message through `ApiError` rather than being genericised
      // by the 5xx branch of the error handler. `state` moves into
      // `details` so the body is the same envelope as every other error.
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }

    if (q.departAfter !== undefined && q.arriveBy !== undefined) {
      throw app.httpErrors.badRequest("Pass exactly one of departAfter or arriveBy");
    }

    let lang: Lang;
    let from: ParsedPlace;
    let to: ParsedPlace;
    try {
      lang = parseLang(q.lang);
      from = parsePlace(q.from);
      to = parsePlace(q.to);
    } catch (err) {
      throw app.httpErrors.badRequest((err as Error).message);
    }

    const raw = q.arriveBy ?? q.departAfter;
    const at = raw === undefined ? new Date() : new Date(raw);
    if (Number.isNaN(at.getTime())) {
      throw app.httpErrors.badRequest(`Invalid time: ${raw}`);
    }

    // The feed holds only ~30 days. An empty result for a date months out is
    // indistinguishable from "no service exists"; say so explicitly instead.
    // Read fresh from `app.calendar` on every request -- never hardcoded --
    // so this stays correct across a feed refresh without a redeploy.
    const window = serviceWindow(app.calendar);
    const ymd = ymdOf(at, config.timezone);
    if (ymd < window.start || ymd > window.end) {
      throw new ApiError(
        422, "date_outside_service_window",
        `The loaded feed covers ${window.start} to ${window.end}; ${ymd} is outside it.`,
        { details: { serviceWindow: window } },
      );
    }

    const maxWalk = q.maxWalkMeters ?? walkConfig.maxMeters;
    const origin = accessStops(ix, from, maxWalk, walkConfig.speedMps);
    const target = accessStops(ix, to, maxWalk, walkConfig.speedMps);

    // An unresolved `stop:<id>` is a bad id, not a walking-distance problem
    // -- it must 404 here, before it can ever reach the nearest-stop
    // fallback or the walking-distance 422 below, both of which would now
    // misreport it as "no stop within N m" (there is no walk to measure: the
    // id itself does not exist). `accessStops`'s own doc comment: `point` is
    // null ONLY on this branch -- a `kind: "coord"` place always sets it,
    // and a RESOLVED `kind: "stop"` place sets it to that stop's own
    // coordinates -- so `point === null` is an exact test for "this id is
    // not in the loaded feed", not a heuristic. Mirrors the `No <thing> with
    // id ${id}` / `app.httpErrors.notFound` convention every other route
    // (trips.ts, departures.ts, stops.ts, lines.ts) already uses for an
    // unknown id, rather than a hand-built `ApiError`.
    if (from.kind === "stop" && origin.point === null) {
      throw app.httpErrors.notFound(`No stop with id ${from.stopId}`);
    }
    if (to.kind === "stop" && target.point === null) {
      throw app.httpErrors.notFound(`No stop with id ${to.stopId}`);
    }

    // Parsed before refinement, deliberately: refinement costs a Valhalla
    // round-trip per coordinate endpoint, and a malformed `modes` value is a
    // pure client mistake that should 400 before paying for either one, not
    // after.
    let modes: Set<number> | null;
    try {
      modes = q.modes === undefined ? null : parseModes(q.modes);
    } catch (err) {
      throw app.httpErrors.badRequest((err as Error).message);
    }

    // Only a coordinate endpoint has a walk to route. Keyed on the parsed
    // place's `kind`, NOT on `point`: accessStops sets `point` to the stop's
    // own coordinates for a valid `stop:` endpoint and returns null only for
    // an unknown stop id, so a null check would refine every stop: query.
    // (`point !== null` is defence-in-depth, not load-bearing here: for a
    // `kind: "coord"` place `accessStops` always sets `point` to that same
    // coordinate and never returns null -- null is only ever the `kind:
    // "stop"` unknown-id case, already excluded by the `kind` check.)
    //
    // `originRefined`/`targetRefined` record whether that endpoint's
    // `secondsToReach` values are now real Valhalla durations rather than
    // still the 1.33 m/s estimate `accessStops` produced them with --
    // `walkLeg` below uses them to set `walkEstimated` honestly. Both start
    // false: a `stop:` endpoint is never refined (nothing to route), and
    // that default is exactly right for it too, since no walk leg is ever
    // built for a zero-second access/egress anyway.
    let originRefined = false;
    let targetRefined = false;
    if (from.kind === "coord" && origin.point !== null) {
      const refined = await refineAccessByWalking(
        app.valhalla, origin.point, origin.stops, { ix, maxWalkMeters: maxWalk });
      origin.stops = refined.stops;
      originRefined = refined.refined;
      // The only server-side signal that this endpoint's access legs fell
      // back to the straight-line estimate: on a single self-hosted box with
      // no metrics, a Valhalla outage is otherwise invisible except as a
      // boolean in the response body. `accessRefine.ts` stays free of
      // Fastify, so this logs from the call site rather than a logger
      // threaded into that module. No coordinates -- just enough to
      // diagnose which endpoint and how large the candidate set was.
      if (!originRefined) {
        req.log.warn(
          { endpoint: "origin", candidates: origin.stops.length },
          "access walk refinement did not run; using straight-line estimates",
        );
      }
    }
    if (to.kind === "coord" && target.point !== null) {
      const refined = await refineAccessByWalking(
        app.valhalla, target.point, target.stops, { ix, maxWalkMeters: maxWalk });
      target.stops = refined.stops;
      targetRefined = refined.refined;
      if (!targetRefined) {
        req.log.warn(
          { endpoint: "destination", candidates: target.stops.length },
          "egress walk refinement did not run; using straight-line estimates",
        );
      }
    }

    // Nearest-stop fallback. The first/last stop is simply the closest one
    // to the origin/destination, with `maxWalkMeters` not applying to it --
    // someone standing somewhere with sparse transit is exactly who a 422
    // here serves worst. Runs per
    // endpoint, independently, only when THAT endpoint's own two-stage
    // filter -- the haversine prefilter inside `accessStops` above, then the
    // real-walking-distance refinement just run -- left it with nothing.
    // Only a coordinate endpoint reaches this: a `stop:` endpoint always
    // resolves to exactly that stop (see `accessStops`'s own doc comment)
    // and is unaffected by this fallback.
    //
    // `maxWalkMeters: Infinity` -- not a mode flag -- lifts the cap for this
    // one call. `refineAccessByWalking`'s own guard reads
    // `!Number.isFinite(cost.distanceMeters) || ... || cost.distanceMeters >
    // opts.maxWalkMeters`: a finite real distance is never `>` `Infinity`, so
    // nothing is dropped for being too far. Only Valhalla's own "no
    // pedestrian path at all" (`cost === null`) or a malformed matrix cell
    // still removes a candidate here -- unreachable on foot is still
    // unreachable, cap or no cap.
    //
    // Degrades exactly like the ordinary path: `refineAccessByWalking`
    // itself never throws (matrix failure, timeout or a malformed response
    // all return the untouched candidates with `refined: false`), so a
    // Valhalla outage leaves the fallback stops carrying `nearestStops`'s own
    // straight-line estimate rather than emptying the set -- the same
    // degrade-not-fail contract every other caller of this module relies on.
    if (from.kind === "coord" && origin.point !== null && origin.stops.length === 0) {
      const nearest = nearestStops(
        ix, origin.point, NEAREST_STOP_FALLBACK_COUNT, walkConfig.speedMps);
      const refined = await refineAccessByWalking(
        app.valhalla, origin.point, nearest, { ix, maxWalkMeters: Infinity });
      origin.stops = refined.stops;
      originRefined = refined.refined;
      if (!originRefined) {
        req.log.warn(
          { endpoint: "origin", candidates: origin.stops.length },
          "nearest-stop fallback engaged; access walk refinement did not run, using straight-line estimates",
        );
      }
    }
    if (to.kind === "coord" && target.point !== null && target.stops.length === 0) {
      const nearest = nearestStops(
        ix, target.point, NEAREST_STOP_FALLBACK_COUNT, walkConfig.speedMps);
      const refined = await refineAccessByWalking(
        app.valhalla, target.point, nearest, { ix, maxWalkMeters: Infinity });
      target.stops = refined.stops;
      targetRefined = refined.refined;
      if (!targetRefined) {
        req.log.warn(
          { endpoint: "destination", candidates: target.stops.length },
          "nearest-stop fallback engaged; egress walk refinement did not run, using straight-line estimates",
        );
      }
    }

    // Reachable now only when the fallback above ALSO found nothing for that
    // endpoint. An unresolved `stop:<id>` cannot land here any more -- it
    // 404s above, before the fallback ever runs. `nearestStops` scans every
    // stop in the index and the fallback call itself has no distance cap, so
    // what is left is genuinely exhausted, not merely "nothing in range":
    //
    //  - the index has no stops at all (`ix.nStops === 0`), so there was
    //    nothing for `nearestStops` to return in the first place; or
    //  - Valhalla resolved the fallback's own (uncapped) matrix call but
    //    reported every one of the N nearest candidates as unreachable ON
    //    FOOT (`cost === null` -- "no pedestrian path", not "too far"; see
    //    `refineAccessByWalking`'s own doc comment) -- a coordinate offshore,
    //    inside a fenced-off zone, or on a road with no pedestrian access all
    //    produce this -- worth spelling out explicitly rather than "etc.",
    //    since an all-null matrix row is easy to overlook as a case.
    //
    // Both are genuine "nothing to plan from" outcomes, so a client deserves
    // a clear error here rather than an empty itinerary list.
    if (origin.stops.length === 0) {
      throw new ApiError(
        422, "no_stops_near_origin",
        `No stop within ${maxWalk} m walking distance of the origin.`,
      );
    }
    if (target.stops.length === 0) {
      throw new ApiError(
        422, "no_stops_near_destination",
        `No stop within ${maxWalk} m walking distance of the destination.`,
      );
    }

    const tripFilter = (modes === null && !q.wheelchair)
      ? undefined
      : (t: number): boolean => {
          if (q.wheelchair && ix.tripWheelchair[t] !== 1) return false;
          if (modes !== null) {
            const type = app.routeTypeByIdx[ix.tripRouteIdx[t]!];
            if (type === undefined || !modes.has(type)) return false;
          }
          return true;
        };

    const days = buildDayContexts(ix, app.calendar, at, config.timezone);
    const maxRounds = q.maxTransfers + 1;

    // The headway-scaled transfer margin. Built ONCE per request; see
    // `baseQuery` below for how this reaches every RAPTOR-shaped caller.
    //
    // `headwayTableFor` is the memoised builder (`transit/headway.ts`):
    // `buildHeadwayTable` itself (the uncached build) measures 16.5 ms cold,
    // 10.9-11.7 ms warm per service day against this repo's real
    // `data/gtfs.sqlite` (not a synthetic index); `headwayTableFor`'s own
    // wrapper measures 22.7 ms on a cache miss and 0.004 ms on a hit. This
    // request already spans two service days via `days`. `days.map` keeps
    // `transfer.headway` exactly parallel to `days`, index for index -- the
    // shape both RAPTOR passes validate at entry
    // (`validateTransferContract`) and throw on a mismatch.
    //
    // `cfg.baseSeconds` MUST equal `walkConfig.transferMinSeconds`: it is the
    // value footpath edges already bake in, and the value the headway-scaled
    // margin is measured on top of -- both passes refuse a `cfg` that gets
    // this wrong. `factor === 0` (`TRANSFER_HEADWAY_FACTOR=0`) is the tested
    // off switch: `requiredTransferSeconds` short-circuits to `baseSeconds`
    // unconditionally in that case, so every itinerary below is identical to
    // today's.
    const transfer: TransferMargin = {
      cfg: {
        baseSeconds: walkConfig.transferMinSeconds,
        factor: walkConfig.headwayFactor,
        capSeconds: walkConfig.transferMaxSeconds,
      },
      headway: days.map((day) => headwayTableFor(ix, day)),
    };

    // The fields every RAPTOR-shaped call below shares, hoisted into ONE
    // object and spread into all three: the two direct `runRaptor`/
    // `runRaptorReverse` calls, and the `reverseQuery` object handed to
    // `reoptimiseBounded` (`Omit<ReverseQuery, "arriveByEpoch" |
    // "maxRounds">` -- exactly this object's own shape, so spreading it
    // there needs no `arriveByEpoch`/`maxRounds` to be stripped). This guards
    // specifically against forgetting `transfer`: with three separate object
    // literals, omitting `transfer` on one is possible without a type error
    // (it is optional on both query types), and no existing test would
    // catch it except a purpose-built one. With one shared object, there is
    // exactly one place `transfer` (or `days`, or `tripFilter`) can be
    // forgotten, and a caller in another file that reuses `baseQuery`
    // inherits it automatically.
    // The live view of the timetable for these service days, or `undefined`
    // when realtime is off, stale, or has nothing late -- in which case both
    // passes take their untouched, schedule-only path. Built once per realtime
    // snapshot and shared across requests (`shiftsFor`), not once per query:
    // re-sorting the touched patterns costs ~124 ms on this feed at rush hour,
    // which is affordable every 20 s and not affordable per request.
    //
    // It rides on `baseQuery` for exactly the reason the comment above gives
    // for `transfer`, `days` and `tripFilter`: one place to forget it, and
    // every derived query -- the reverse probe, the alternatives re-plan --
    // inherits it automatically rather than silently searching a different
    // timetable from the one that produced the itinerary it is refining.
    const shift = shiftsFor(ix, app.realtime, days);

    const baseQuery = {
      origins: origin.stops, destinations: target.stops,
      days, transferMinSeconds: walkConfig.transferMinSeconds, tripFilter, transfer,
      shift,
    };

    const routeOf = (routeIdx: number): {
      id: string; agencyId: string | null; shortName: string | null;
      longName: string | null; type: number; color: string | null;
    } => app.routeBriefByIdx[routeIdx] ?? {
      id: "", agencyId: null, shortName: null, longName: null, type: 3, color: null,
    };

    const walkLeg = (
      point: LatLon | null, stopIdx: number, seconds: number, outbound: boolean,
      refined: boolean,
    ): WalkLeg | undefined =>
      buildWalkLeg(ix, app.translator, lang, point, stopIdx, seconds, outbound, refined);

    /**
     * One complete plan, at ONE transfer margin: the RAPTOR pass for this
     * query's direction, the Pareto pick, chain reconstruction, and (on the
     * `departAfter` branch) departure re-optimisation. Called once with the
     * configured margin, and at most once more with a flat one -- see the
     * query-level retry below for when and why.
     *
     * `margin` is threaded rather than closed over precisely so the retry
     * cannot accidentally re-run at the same margin: `query` below overrides
     * `baseQuery`'s own `transfer`, and every RAPTOR-shaped call in here --
     * including the `reverseQuery` handed to `reoptimiseBounded` -- spreads
     * `query`, so there is exactly one place the margin enters.
     */
    const search = (margin: TransferMargin, live: typeof shift): {
      itineraries: Itinerary[]; reverseSourced: boolean[]; probeSourced: boolean[];
    } => {
      const query = { ...baseQuery, transfer: margin, shift: live };

      const itineraries: Itinerary[] = [];
      // Parallel to `itineraries`, index for index: whether each one was
      // built by the REVERSE pass (`raptorReverse.ts`) rather than the
      // forward one (`raptor.ts`). Every `arriveBy` itinerary is reverse-built
      // by construction; a `departAfter` one is forward-built UNLESS
      // `reoptimiseBounded` swapped it onto a reverse-reconstructed chain (see
      // each push site below for how that is detected). The margin the two
      // passes charge is not the same value (`raptorReverse.ts`'s
      // `extraAlightingSeconds` charges the MAXIMUM over its readiness window,
      // which is always >= the forward pointwise value) -- see
      // `requiredMarginFor`'s own doc comment -- so `computeTransferAtRisk`
      // needs to know which rule actually built each itinerary to compare
      // against the SAME one, not always the forward one.
      const reverseSourced: boolean[] = [];
      // Also parallel to `itineraries`: whether each one came from the
      // reverse PROBE specifically (the `departAfter` branch's extra
      // reverse pass at a relaxed deadline), as opposed to any other reverse
      // involvement. Deliberately a SEPARATE array from `reverseSourced`
      // rather than a reuse of it: `reverseSourced` is also true for an
      // itinerary `reoptimiseBounded` swapped onto a reverse-reconstructed
      // chain, which is a different thing entirely -- that itinerary carries
      // no arrival bound of its own and must stay subject to the
      // departure window, while a probe candidate is bounded on arrival by
      // construction and must not. See `rankItineraries`' `exempt` option for
      // why conflating the two would bury exactly the journeys the probe
      // exists to find.
      const probeSourced: boolean[] = [];

      if (q.arriveBy !== undefined) {
        const res = runRaptorReverse(ix, {
          ...query,
          arriveByEpoch: Math.floor(at.getTime() / 1000),
          maxRounds,
        });
        // Reverse labels carry latest departures. `paretoRounds` always
        // minimises an `arrivalEpoch`-shaped field, so the reverse pass feeds
        // it the NEGATION of each departure: minimising `-departureEpoch` is
        // the same ordering as maximising `departureEpoch` (a later departure
        // is "better" for arriveBy, the mirror of an earlier arrival being
        // better for departAfter). Whatever `paretoRounds` hands back in its
        // own `arrivalEpoch` field here is consequently that SAME negated
        // pseudo-value, not a real epoch -- it is deliberately unused below,
        // since only `round`/`stopIdx` (which pick out which reconstructed
        // chain to keep) are needed; treating that field as a real timestamp
        // anywhere would produce an absurd (negative, 1970-ish) time.
        // `accept: hasRiddenReverse` -- round 0 is walk-only by construction
        // and the planner drops walk-only itineraries unconditionally,
        // so letting one win a round's pick would suppress every transit
        // round behind a journey that cannot itself be returned. A ROUND
        // cutoff cannot do this job (see `paretoRounds`' own doc comment for
        // why); the label's own chain can, which is why the map below keeps
        // the original `ReverseLabel` alongside the negated pseudo-arrival,
        // as `src`, for `accept` to inspect.
        const picks = paretoRounds(
          res.rounds.map((round) => round.map((l) =>
            l === null ? null : { arrivalEpoch: -l.departureEpoch, src: l })),
          origin.stops,
          { accept: (c) => hasRiddenReverse(c.src) },
        );
        for (const pick of picks.slice(0, q.results)) {
          const chain = reconstructReverseChain(ix, res.rounds, pick.round, pick.stopIdx);
          if (chain === null) continue;
          // `pick.stopIdx` is an ORIGIN stop here -- `picks` was built by
          // feeding `origin.stops` to `paretoRounds` above (the reverse
          // mirror of the forward branch feeding it `target.stops`), so it is
          // correct for the access leg but WRONG for the egress leg. The
          // egress-side stop is wherever the reconstructed chain actually
          // ends: `reconstructReverseChain` returns its chain already in
          // travel order (origin -> destination; see its own doc comment and
          // `reconstructReverse`'s), so `chain[chain.length - 1]` is the
          // destination-side stop the egress walk must be measured from --
          // confirmed by tracing a synthetic 2-leg reverse query end to end
          // (chain[0] was the origin stop, chain[last] was exactly the
          // destination stop passed as `destinations` to `runRaptorReverse`).
          const accessSeconds =
            origin.stops.find((o) => o.stopIdx === pick.stopIdx)?.secondsToReach ?? 0;
          const egressStopIdx = chain[chain.length - 1]!.stopIdx;
          const egressSeconds =
            target.stops.find((t) => t.stopIdx === egressStopIdx)?.secondsToReach ?? 0;
          const itin = buildItinerary(ix, chain, {
            tr: app.translator, lang, tz: config.timezone, days, routeOf,
            transferMinSeconds: walkConfig.transferMinSeconds, shift: live,
            accessLeg: walkLeg(origin.point, pick.stopIdx, accessSeconds, true, originRefined),
            egressLeg: walkLeg(target.point, egressStopIdx, egressSeconds, false, targetRefined),
          });
          // Discard a journey that "arrives by" the deadline only by arriving
          // a full day-or-more before it -- see ARRIVE_BY_MAX_LOOKBACK_SECONDS.
          // `itin.arrivalTime` was just produced by `toIso` above, so parsing
          // it back is exact; there is no earlier raw epoch left in scope here
          // once egress has been folded in.
          const arrivalEpoch = Date.parse(itin.arrivalTime) / 1000;
          if (arrivalEpoch < Math.floor(at.getTime() / 1000) - ARRIVE_BY_MAX_LOOKBACK_SECONDS) {
            continue;
          }
          // Discard a journey with a nonsensically long single wait between
          // two rides -- see ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS. Gated on the
          // headway-scaled margin actually being enabled: this branch is what
          // makes the overnight fallback this bound exists for reachable more
          // often (a same-day connection the flat rule would have accepted
          // can now fail the margin, forcing the reverse search to fall back
          // further), so the guard belongs to the FEATURE, not to the
          // planner unconditionally -- `TRANSFER_HEADWAY_FACTOR=0` must still
          // restore today's exact behaviour on this branch too.
          //
          // `transfer.cfg.factor`, NOT this pass's own `margin.cfg.factor`:
          // the gate asks "is the feature on for this REQUEST", and since the
          // relaxed second search below runs at `factor: 0` by construction,
          // reading the pass's own factor switched the bound OFF for exactly
          // the pass that most needs it. That regressed the fixture behind
          // "the wait bound is genuinely gated on the feature, not just on
          // reachability": the flat pass happily returned the ~13h50m-wait
          // `TFEED -> T4X` chain the configured pass had just rejected, which
          // is the "you waited overnight at a bus stop" answer this planner
          // is designed to rule out. The request-level read keeps the off switch exact
          // (`TRANSFER_HEADWAY_FACTOR=0` skips the relaxed search entirely, so
          // `transfer.cfg.factor === 0` and the bound is off everywhere, as
          // before) while making the bound apply to BOTH passes whenever the
          // feature is on.
          if (transfer.cfg.factor !== 0
              && maxTransferWaitSeconds(itin.legs) > ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS) {
            continue;
          }
          itineraries.push(itin);
          // Every `arriveBy` itinerary is built by `reconstructReverseChain`
          // -- the reverse pass, always.
          reverseSourced.push(true);
          // The reverse probe is a `departAfter`-branch construct; this
          // branch's own reverse pass is the query the rider asked for.
          probeSourced.push(false);
        }
      } else {
        const res = runRaptor(ix, {
          ...query,
          departAfterEpoch: Math.floor(at.getTime() / 1000),
          maxRounds,
        });
        // Builds an itinerary from any forward-SHAPED chain -- either the
        // forward pass's own chain, or a reverse-reconstructed one
        // (`reconstructReverseChain` returns the identical `{ stopIdx, label
        // }[]` shape; see reoptimise.ts) -- deriving the access/egress walk
        // legs from wherever the chain actually starts/ends, exactly as the
        // `arriveBy` branch above does. Passed to `reoptimiseItinerary` so it
        // can rebuild a candidate from a reverse-pass chain without this route
        // handler's translator/route-lookup/walk-leg machinery leaking into
        // reoptimise.ts.
        const buildFrom = (chain: { stopIdx: number; label: Label }[]): Itinerary => {
          const accessStopIdx = chain[0]!.stopIdx;
          const egressStopIdx = chain[chain.length - 1]!.stopIdx;
          const accessSeconds =
            origin.stops.find((o) => o.stopIdx === accessStopIdx)?.secondsToReach ?? 0;
          const egressSeconds =
            target.stops.find((t) => t.stopIdx === egressStopIdx)?.secondsToReach ?? 0;
          return buildItinerary(ix, chain, {
            tr: app.translator, lang, tz: config.timezone, days, routeOf,
            transferMinSeconds: walkConfig.transferMinSeconds, shift: live,
            accessLeg: walkLeg(origin.point, accessStopIdx, accessSeconds, true, originRefined),
            egressLeg: walkLeg(target.point, egressStopIdx, egressSeconds, false, targetRefined),
          });
        };

        // `accept: hasRidden` -- see the `arriveBy` branch above.
        for (const pick of paretoRounds(res.rounds, target.stops, { accept: hasRidden })
          .slice(0, q.results)) {
          const chain = reconstructForward(ix, res.rounds, pick.round, pick.stopIdx);
          if (chain === null) continue;
          // Re-anchor on the actual boarding (see reoptimise.ts), then check
          // whether an even later departure reaches the SAME arrival in the
          // SAME number of transfers -- step one alone cannot find that; only
          // running the reverse pass backwards from the arrival can. Order
          // matters: geometry (below, after this loop) must not be resolved
          // until reoptimisation has settled on the itinerary actually
          // returned, or it would be computed for a chain that gets replaced.
          // Re-anchoring is UNCONDITIONAL; only the reverse-pass refinement is
          // bounded, and `reoptimiseBounded` is where that invariant lives. An
          // itinerary past the bound still reports its own first boarding
          // rather than the query instant -- the regression this whole feature
          // exists to fix never comes back for the tail of the list, it just
          // stops being refined further. See
          // `planConfig.reoptimiseMaxItineraries` for the measurements behind
          // the bound. `itineraries.length` is the index of the member about to
          // be pushed, so this keeps the FIRST N in SEARCH-TIME order --
          // `paretoRounds` orders fewest-transfers-first within this one
          // `search()` call. That is no longer the client-facing order:
          // `rankItineraries` (called on the merged, forward-plus-probe set,
          // after this function returns) re-sorts and can put a later, lower-
          // effort candidate first, including a probe-sourced one appended
          // after every forward pick. Re-anchoring itself remains
          // unconditional regardless of position; only this refinement is
          // search-time-position-dependent.
          const raw = buildFrom(chain);
          const built = reoptimiseBounded(
            itineraries.length, planConfig.reoptimiseMaxItineraries, raw,
            {
              ix, tz: config.timezone,
              reverseQuery: query,
              buildFrom,
            },
          );
          itineraries.push(built);
          // `reoptimiseBounded` re-anchors `raw` via a shallow spread
          // (`reoptimise.ts`'s `reanchorDeparture`: `{...itinerary,
          // departureTime, durationSeconds}`), which keeps `legs` pointing at
          // the EXACT SAME array -- re-anchoring alone never rebuilds it. The
          // only thing that ever replaces `.legs` with a NEW array is
          // `reoptimiseItinerary` finding a strictly-later valid departure via
          // `deps.buildFrom(chain)` on a REVERSE-reconstructed chain (see its
          // own doc comment: `best` starts as the forward `itinerary` argument
          // and is only ever reassigned to that new, reverse-built
          // `candidate`). So `built.legs !== raw.legs` is exact, not a
          // heuristic, for "was this itinerary actually swapped onto a
          // reverse-pass chain" -- no change to reoptimise.ts needed to know
          // it from here.
          reverseSourced.push(built.legs !== raw.legs);
          // Forward pick, whether or not reoptimisation swapped its chain: the
          // probe below is the only producer of `probeSourced: true`.
          probeSourced.push(false);
        }

        // The reverse probe. The forward pass minimises arrival, so a journey
        // that departs later AND arrives later is dominated and never becomes
        // a candidate -- no amount of reordering can surface it. The reverse
        // pass maximises departure, which is exactly the missing half.
        //
        // This is not a new algorithm: it is the `arriveBy` branch above, run
        // internally at a RELAXED deadline. `buildFrom` handles a reverse
        // chain unchanged, because `reconstructReverseChain` returns its chain
        // in travel order and `buildFrom` derives both walks from wherever the
        // chain actually starts and ends.
        //
        // Cost is ONE extra pass per probe and is INDEPENDENT OF WINDOW WIDTH
        // -- widening the window moves the deadline, not the work. A full
        // range search (one forward pass per departure in the window) is the
        // textbook answer and is what this deliberately is not: on the target
        // box that is seconds, not milliseconds.
        const earliestArrivalEpoch = itineraries.length === 0
          ? null
          : Math.min(...itineraries.map((i) => Math.floor(Date.parse(i.arrivalTime) / 1000)));
        if (earliestArrivalEpoch !== null) {
          const atEpoch = Math.floor(at.getTime() / 1000);
          for (let probe = 1; probe <= rankConfig.reverseProbes; probe++) {
            // Probes are spread evenly up to `earliestArrival + window`, so
            // `reverseProbes = 1` is exactly the design's single deadline and
            // higher values interpolate rather than extend past it -- the
            // escape hatch for MIDDLE departures, which is the documented
            // limitation of this approach.
            const deadline = earliestArrivalEpoch
              + Math.round(rankConfig.departureWindowSeconds * probe / rankConfig.reverseProbes);
            const rev = runRaptorReverse(ix, { ...query, arriveByEpoch: deadline, maxRounds });
            // Same negation trick as the `arriveBy` branch: `paretoRounds`
            // minimises an `arrivalEpoch`-shaped field, and minimising
            // `-departureEpoch` is maximising `departureEpoch`. The returned
            // `arrivalEpoch` is that negated pseudo-value and is not read.
            // `accept: hasRiddenReverse` -- see the `arriveBy` branch above.
            const picks = paretoRounds(
              rev.rounds.map((round) => round.map((l) =>
                l === null ? null : { arrivalEpoch: -l.departureEpoch, src: l })),
              origin.stops,
              { accept: (c) => hasRiddenReverse(c.src) },
            );
            for (const pick of picks.slice(0, q.results)) {
              const chain = reconstructReverseChain(ix, rev.rounds, pick.round, pick.stopIdx);
              if (chain === null) continue;
              const candidate = buildFrom(chain);
              // LOAD-BEARING. The reverse pass walks BACKWARD from its
              // deadline with no lower bound on departure, so it will happily
              // reconstruct a chain that left hours before the rider asked to
              // travel -- a bus they cannot board. The forward pass cannot
              // produce this (it is seeded at `at`), so this guard exists
              // solely for the probe.
              if (Math.floor(Date.parse(candidate.departureTime) / 1000) < atEpoch) continue;
              // The same absurd-interior-wait guard the `arriveBy` branch
              // applies above, for the same reason and on the same gate: this
              // is a reverse-BUILT chain, so in sparse service it can be
              // stitched across a half-day gap between two rides, and nothing
              // else here would catch it. Gated on `margin.cfg.factor !== 0`
              // identically, so `TRANSFER_HEADWAY_FACTOR=0` stays byte-exact
              // on this branch too.
              //
              // ARRIVE_BY_MAX_LOOKBACK_SECONDS deliberately NOT applied here:
              // it exists to reject a journey that "arrives by" the deadline
              // only by arriving a day early, and the `>= atEpoch` guard
              // immediately above is strictly stronger for a probe -- a chain
              // departing at or after the query instant cannot arrive a day
              // before a deadline that is itself only `departureWindowSeconds`
              // past the forward pass's earliest arrival.
              // `transfer.cfg.factor`, not `margin.cfg.factor` -- same
              // reason as the `arriveBy` branch's own copy of this bound
              // above: the relaxed second search runs at factor 0 by
              // construction, so reading the pass's factor would disable the
              // bound for precisely that pass.
              if (transfer.cfg.factor !== 0
                  && maxTransferWaitSeconds(candidate.legs)
                    > ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS) {
                continue;
              }
              itineraries.push(candidate);
              // Reverse-BUILT, so `computeTransferAtRisk` must compare it
              // against `raptorReverse.ts`'s maximum-over-window margin rather
              // than the forward pointwise one -- the same reason every
              // `arriveBy` itinerary reports `true` here.
              reverseSourced.push(true);
              // Probe-sourced: exempt from the departure window at
              // the ranking site below, because its arrival is already bounded
              // by `deadline` above. See `rankItineraries`' `exempt`.
              probeSourced.push(true);
            }
          }
        }
      }

      return { itineraries, reverseSourced, probeSourced };
    };

    // Layer one of the last-service handling is the per-connection fallback
    // inside the two RAPTOR passes: at the last service of the day the margin yields to the
    // flat buffer rather than delete the journey. It cannot close a CHAIN
    // effect, where every individual connection is handled correctly and the
    // journey still disappears -- the margin legitimately moves the rider
    // onto a later trip at one interchange, and by the time they get there
    // the last service on a downstream leg has gone. Measured on the real
    // feed: 1 of 241 random late-evening queries.
    //
    // Layer two closes it by construction rather than by argument: run the
    // identical query at the flat rule as well, and MERGE both candidate
    // sets before ranking.
    //
    // The guarantee is stated exactly: "no query is left EMPTY that the flat
    // rule could answer" -- explicitly NOT "never fewer journeys than the
    // flat rule". A narrower guard, applied only when the margin-respecting
    // search comes back EMPTY, was measured on 513 routable queries to leave
    // 138 of them (26.9%) with fewer itineraries than the flat rule finds,
    // and the cost of the ones it drops is not small. Re-measured against a
    // reference planner on 11 real trips (all departing 08:00), the
    // configured margin gave up 42 minutes of arrival time in total, worse on
    // 6 of 11, with single-query losses of 16 min (Dizengoff Center ->
    // Weizmann Institute), 21 min (Kiryat Shmona -> Technion) and 9 min
    // (Ashkelon -> Kfar Saba). Merging both sets takes that to 28 minutes
    // better in total, worse on 2 (by one minute each). The dropped journeys
    // were not marginal; they were the answer.
    //
    // The reasoning that justifies yielding to the flat rule on an empty
    // result is the same reasoning that justifies offering it here: "a
    // journey you might miss, clearly labelled, beats an empty result for
    // someone standing at a stop at 22:15." The only thing that changes is
    // the threshold of "beats".
    // Refusing a 96-second connection onto a bus that runs every 15 minutes
    // does not cost the rider 15 minutes, which is all missing it could ever
    // cost -- it cost them 45, because the refusal does not move them to the
    // next trip on the same line, it moves them onto a structurally
    // different and much worse journey. An insurance premium must not exceed
    // the loss it insures against, and as a hard feasibility gate this one
    // could, without bound.
    //
    // Nothing is lost by merging, which is why this is a merge and not a
    // replacement: the margin-respecting set is still searched and still
    // present, so every journey today's planner offers is still offered.
    // The flat set only ADDS candidates. `rankItineraries` then arbitrates
    // over the union -- it already dedupes by `journeyKey` (both searches
    // find most of the same journeys) and already orders by rider effort
    // "regardless of which round or which SEARCH produced it" -- and
    // `annotateTransferRisk` below runs against the CONFIGURED margin, so
    // every connection the real rule wanted more slack for comes back
    // flagged `transferAtRisk`. The rider is told, rather than silently
    // handed a 45-minute detour they never asked for.
    //
    // The `factor !== 0` guard skips the second search only when the FEATURE
    // is off, so `TRANSFER_HEADWAY_FACTOR=0` stays byte-exact and costs
    // exactly one search.
    //
    // COST: a second search on every query rather than only on empty ones.
    // That is the deliberate trade this makes, in exchange for the guarantee
    // the measurement above requires.
    const searchBoth = (live: typeof shift): {
      itineraries: Itinerary[]; reverseSourced: boolean[]; probeSourced: boolean[];
    } => {
      const strict = search(transfer, live);
      if (transfer.cfg.factor === 0) return strict;
      const flat: TransferMargin = {
        // Same `headway` tables, deliberately: `validateTransferContract`
        // requires them parallel to `days`, and `requiredTransferSeconds`
        // short-circuits on `factor === 0` without ever reading them.
        cfg: { ...transfer.cfg, factor: 0 },
        headway: transfer.headway,
      };
      const relaxed = search(flat, live);
      // Concatenated, keeping all three arrays parallel index for index --
      // `rankItineraries` reorders the wrapper that carries them together,
      // and `annotateRealtime`/`annotateTransferRisk` index `reverseSourced`
      // against `itineraries` position for position.
      return {
        itineraries: strict.itineraries.concat(relaxed.itineraries),
        reverseSourced: strict.reverseSourced.concat(relaxed.reverseSourced),
        probeSourced: strict.probeSourced.concat(relaxed.probeSourced),
      };
    };

    let { itineraries, reverseSourced, probeSourced } = searchBoth(shift);

    // THE REALTIME YIELD -- the same shape as the last-service margin yield:
    // live delays may not DELETE a rider's journey. Searching the shifted
    // timetable is what lets a late bus be boarded at all, but it can equally
    // refuse a connection the timetable offers -- and when that leaves nothing
    // whatsoever, the honest answer is not an empty result. It is the
    // scheduled journey, which `annotateRealtime` then flags through
    // `transferAtRisk` from the very predictions that refused it here.
    //
    // The last-service fallback states the principle for the last service of
    // the day ("it does not push the rider onto a later trip -- it deletes
    // their journey"); a rider
    // standing at a stop whose only connection is running late is the same
    // person. Scoped to the TOTAL-emptiness case deliberately: a query that
    // still has some live-feasible journey keeps only those, because there the
    // shifted answer is both true and useful.
    //
    // Costs a second pair of searches only on a query that would otherwise
    // return nothing, which is rare and already the slowest thing a rider can
    // ask for.
    if (itineraries.length === 0 && shift !== undefined) {
      ({ itineraries, reverseSourced, probeSourced } = searchBoth(undefined));
    }

    // Ordering is by RIDER EFFORT, not by arrival.
    //
    // Only ONE sort must ever run at this anchor: if a second, different
    // sort were added downstream, whichever ran LAST would win and could
    // silently destroy effort ordering with no test failing.
    //
    // Fewest-transfers-first is deliberately not used: a one-transfer
    // twelve-minute journey outranks a zero-transfer twenty-minute one,
    // because `transferPenaltySeconds` prices an interchange at what it
    // actually costs a rider instead of making it lexicographically
    // decisive. Duration alone is deliberately not the tiebreak either,
    // because it prices a walking minute and a riding minute the same,
    // which is the defect that let a 17-minutes-of-walking journey be
    // returned as the best answer to a 20-minute trip.
    //
    // This also fixes a real ordering bug: `paretoRounds` orders BY ROUND
    // only, so a 22-minute 0-transfer itinerary could print before a
    // 15-minute 0-transfer one. Cost is a total order over every candidate
    // regardless of which round or which SEARCH produced it, which the
    // round order never is.
    //
    // Candidates are wrapped with `reverseSourced` rather than ranked bare:
    // `annotateRealtime` and `annotateTransferRisk` below index that array
    // against `itineraries` position for position, and ranking reorders and
    // now also FILTERS, so the two must move together. See `rankItineraries`.
    //
    // `slice` to `q.results` happens HERE, not in `search`, and must stay
    // before the geometry calls below: each branch of `search` may contribute
    // up to `q.results` candidates of its own, so the merged set is larger
    // than the response, and resolving geometry for a candidate that ranking
    // is about to discard is pure waste.
    //
    // `exempt` -- who is let out of the departure window, and why:
    //
    //  - `arriveBy`: EVERYONE. The window exists to stop an unboundedly-
    //    distant departure from displacing a near one. With the ARRIVAL
    //    pinned by the rider's own query there is no such failure mode: a
    //    later departure for the same arrival is unambiguously better for the
    //    rider (less time spent travelling, less time waiting) and is already
    //    strictly cheaper under `journeyCost`, which prices it on
    //    `durationSeconds` from its own re-anchored departure. Worse, the
    //    window INVERTS here: this branch's reverse rounds are monotone in
    //    departure, so the anchor is always the EARLIEST-departing candidate,
    //    and a strictly better later option would be demoted below it. Example
    //    that would misorder with the window on -- `arriveBy 09:00`, a direct
    //    bus 07:00 -> 08:45 (105 min) against a two-bus 08:00 -> 08:50
    //    (50 min): the 105-minute journey would rank first purely for
    //    departing earlier. Cost ordering alone is right on this branch.
    //  - `departAfter`: probe candidates only. See `rankItineraries`' `exempt`
    //    doc comment for the arithmetic -- in short, the probe's bound is on
    //    ARRIVAL (`A_min + W`) and the window's is on DEPARTURE
    //    (`D_forward + W`), and solving the two against each other shows a
    //    probe candidate clears the departure cutoff only when it is NO
    //    FASTER than the forward answer. The probe's whole purpose is finding
    //    faster, lower-effort journeys, so leaving it in the window buries
    //    precisely its best work. Its arrival bound already supplies the
    //    guarantee the window is there for.
    //
    // NOT `reverseSourced`: that flag is also set when `reoptimiseBounded`
    // swaps a forward itinerary onto a reverse chain, which carries no arrival
    // bound and must stay inside the window. Hence the separate
    // `probeSourced` array.
    const exemptFromWindow = q.arriveBy !== undefined
      ? () => true
      : (candidate: { probe: boolean }) => candidate.probe;
    const ranked = rankItineraries(
      itineraries.map((itinerary, i) => ({
        itinerary, reverse: reverseSourced[i]!, probe: probeSourced[i]!,
      })),
      (candidate) => candidate.itinerary,
      rankConfig,
      { exempt: exemptFromWindow },
    ).slice(0, q.results);
    itineraries = ranked.map((candidate) => candidate.itinerary);
    reverseSourced = ranked.map((candidate) => candidate.reverse);

    // The later buses each ride could still be taken on. On the final itineraries
    // only (their windows depend on the itinerary's own connections), and
    // BEFORE geometry and realtime, both of which fill alternatives in too.
    // Where following the itinerary's own stops onwards runs dry, a fresh plan
    // from the stop the later bus drops the rider at -- the same search as
    // this request, at the flat buffer alternatives are measured with.
    const replanArrival = (stopIdx: number, readyEpoch: number): number | null => {
      const res = runRaptor(ix, {
        ...baseQuery,
        transfer: { cfg: { ...transfer.cfg, factor: 0 }, headway: transfer.headway },
        origins: [{ stopIdx, secondsToReach: 0 }],
        departAfterEpoch: readyEpoch,
        maxRounds,
      });
      let best: number | null = null;
      for (const round of res.rounds) {
        for (const destination of target.stops) {
          const label = round[destination.stopIdx];
          if (label === null || label === undefined) continue;
          const door = label.arrivalEpoch + destination.secondsToReach;
          if (best === null || door < best) best = door;
        }
      }
      return best;
    };
    annotateAlternatives(ix, days, itineraries, {
      tr: app.translator, lang, tz: config.timezone, routeOf,
      transferMinSeconds: walkConfig.transferMinSeconds,
      ...alternativesConfig,
      tripFilter,
      replanArrival,
    });

    // Runs AFTER reoptimisation on both branches: reoptimisation can swap a
    // `departAfter` itinerary for a different chain arriving at the same
    // time, so resolving geometry any earlier would be wasted work and could
    // attach geometry to legs that get discarded. Geometry itself is not
    // mode-specific, so both branches share this one call.
    resolveLegGeometry(app.db.db, itineraries);
    // After reoptimisation for the same reason leg geometry is: reoptimisation
    // can swap a journey, and routing walks for discarded legs is both wasted
    // round-trips and a mismatch waiting to happen.
    await resolveWalkGeometry(app.valhalla, itineraries);
    // `app.realtime === null` -- no MOT key yet -- is the overwhelmingly
    // common case; see `annotateRealtime`'s own comment for why nothing
    // needs to run here at all when it's null.
    if (app.realtime !== null) {
      annotateRealtime(app.realtime, ix, config.timezone, days, transfer, reverseSourced, itineraries);
    }
    // Always, and AFTER the realtime pass so it can only ever raise the flag
    // (never overwrite a `true` back to `null`): a yielded
    // connection is a property of the timetable, and the rider is owed it
    // whether or not a SIRI store exists. At `TRANSFER_HEADWAY_FACTOR=0` the
    // required margin is the flat buffer the planner already enforced, so
    // this can never fire and the off switch stays exact.
    annotateTransferRisk(ix, days, transfer, reverseSourced, itineraries);

    return {
      query: {
        from: q.from, to: q.to,
        departAfter: q.departAfter ?? null,
        arriveBy: q.arriveBy ?? null,
        accessStops: origin.stops.length,
        egressStops: target.stops.length,
      },
      itineraries,
    };
  });
};
