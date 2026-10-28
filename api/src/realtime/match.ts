import type { TimetableIndex } from "../transit/index.js";
import type { DayContext } from "../transit/raptor.js";
import type { RealtimeCall, RealtimeJourney } from "./types.js";

/**
 * One stop's predicted arrival, plus whether that prediction is safe to
 * attach to a SPECIFIC leg of a specific itinerary.
 *
 * `ambiguous` is true exactly when the trip's own pattern visits this stop
 * index more than once (a loop) -- see `resolveCalls`'s doc comment for why
 * `expectedArrival` alone cannot then be trusted to belong to any one
 * particular visit. It is computed once, from the trip's OWN pattern
 * structure, never from which call happened to win "soonest" -- so it is
 * the same for every reader regardless of how many calls this stop actually
 * received this tick.
 */
export interface StopPrediction {
  expectedArrival: number;
  ambiguous: boolean;
  /**
   * Epoch seconds at which the vehicle was at the position this prediction
   * was derived from -- the report time, or the scheduled start for a bus
   * still waiting at its origin. Set only by `predictFromDistance`; absent on
   * an operator's own ETA, which is already a prediction about the future.
   *
   * `expectedArrival` assumes the bus kept to the timetable's pace from this
   * instant on. `RealtimeStore` uses it to re-anchor that assumption on the
   * reader's own "now" when the feed is fresh enough for that to help.
   */
  anchorAt?: number;
}

/** A SIRI journey resolved onto the RAPTOR index. */
export interface ResolvedJourney {
  tripIdx: number;
  journey: RealtimeJourney;
  /** Predicted arrival (plus ambiguity), per resolved stop index. */
  byStopIdx: Map<number, StopPrediction>;
}

/**
 * How many journeys from a snapshot resolved to a trip vs. were dropped.
 * Produced by `resolveSnapshot`; the ratio is surfaced on
 * `/meta` so a low resolution rate is visible rather than inferred from
 * response bodies.
 *
 * `resolvedWithNoCalls` is a SUBSET of `resolved`, not an addition to it: a
 * journey that matched a trip (route + direction + scheduled start + day)
 * but whose every call was then dropped by `resolveCalls` (wrong/stale
 * `stop_code`s, or none at all) still counts as `resolved` -- the trip
 * match itself was correct -- but produces a `realtime` block whose fields
 * are all `null`, indistinguishable from "never got here" in every other
 * count. The stop-code join is inference, not observation; if it is wrong,
 * EVERY journey can resolve this way at once, and `resolved`/`unresolved`
 * alone would report a perfectly healthy 100% match rate while the feature
 * does nothing. This field is the one instrument that would catch that
 * silently-total failure.
 */
export interface MatchStats {
  resolved: number;
  unresolved: number;
  resolvedWithNoCalls: number;
  /**
   * Diagnostic only. Of the unresolved journeys,
   * how many matched route + direction + day but missed the EXACT scheduled
   * origin departure by 300 seconds or less. The exact match stays
   * deliberately un-fuzzy (`resolveJourney` never uses this number to
   * resolve anything); this exists purely so a resolution rate stuck at
   * 0% can be told apart from "the whole join key is wrong" (nothing is
   * ever close) versus "the join key has a constant offset" (a timezone
   * slip, minute rounding, or `OriginAimedDepartureTime` naming the first
   * TIMING POINT rather than the first stop) -- the second is a same-day
   * fix, the first is a rewrite, and `resolved`/`unresolved` alone cannot
   * distinguish them.
   */
  nearMissCount: number;
  /**
   * Of `resolved`, how many were matched by pass 2 to an EMPTY slot within
   * `SLOT_WINDOW_SECONDS` rather than exactly -- a run whose MOT start time
   * differs from the timetable. Optional only so the many literals built by
   * hand elsewhere keep compiling; `resolveSnapshot` always sets it.
   */
  attached?: number;
  /** Buses matched to a slot that already had its own, recorded as
   *  `UnscheduledRun`s rather than resolved trips. Always set by
   *  `resolveSnapshot`. */
  unscheduled?: number;
}

/**
 * How far pass 2 will look for a slot. At the 2026-09-10 weekday peak, of
 * 293 fresh buses matching no slot exactly, 255 were within 15 min of one
 * and 38 further. Beyond this, pairing a bus with a slot is more likely wrong
 * than right.
 */
export const SLOT_WINDOW_SECONDS = 900;

/**
 * A live bus matched to a trip whose own slot already has a bus: an extra
 * run, timed as its template shifted by `offsetSeconds`. Kept apart from
 * `ResolvedJourney` on purpose -- nothing that asks "which bus runs THIS
 * trip" (`/plan`, `/vehicles`) may be answered with it.
 */
export interface UnscheduledRun {
  templateTripIdx: number;
  /** The bus's own scheduled start minus the template's, signed seconds
   *  (a 07:55 bus on an 08:00 template is -300). */
  offsetSeconds: number;
  /** `DayContext.baseEpoch` of the service day it runs on, unshifted. The
   *  run's scheduled time at a stop is this + offset + the template's time. */
  serviceBaseEpoch: number;
  journey: RealtimeJourney;
  /** Predictions derived against the SHIFTED timetable. */
  byStopIdx: Map<number, StopPrediction>;
}

/**
 * Precomputed once per index bundle (`buildIndex` runs once per reload, not
 * per request) so `resolveJourney` never touches the database or does
 * anything worse than a couple of map lookups.
 */
export interface TripLookup {
  /**
   * `${routeId}|${directionId}|${originDepartureSecondsIntoServiceDay}` ->
   * trip indices sharing that key.
   *
   * This key is NOT unique on its own: checked against `data/gtfs.sqlite`,
   * 58,433 of 185,644 keys (31%) hold more than one trip, because this feed
   * publishes one `trips.txt` row per calendar date rather than using
   * `calendar_dates.txt` exceptions -- the same physical service repeats
   * across many `service_id`s, one per day it runs. `service_id` is what
   * distinguishes them, and that is exactly what the journey's own
   * `dataFrameRef` (service date) picks out -- checked feed-wide, not
   * assumed: restricted to trips active on a given day, 119,519 active
   * trips produce 119,519 keys with ZERO holding more than one active trip.
   * So the day mask alone disambiguates every collision this key can
   * produce; see `resolveJourney`, which filters candidates by
   * `DayContext.activeTrip` rather than guessing among them.
   */
  byTripKey: Map<string, number[]>;
  /**
   * `stop_code` -> stop indices carrying it. A list because a code is not
   * unique: 34,182 distinct codes cover 35,266 stops.
   */
  byStopCode: Map<string, number[]>;
  /**
   * `route_id` -> its one direction_id, or `null` when the route carries
   * more than one.
   *
   * Exists for SIRI-VM, which reports no direction at all: `resolveJourney`
   * recovers it from here so the trip key stays exactly as exact as it is
   * for SIRI-SM. Checked feed-wide on 2026-09-01, all 7,753 routes have
   * exactly one direction_id, so this resolves for every route in practice
   * -- but a route that ever carried two maps to `null` and its journeys go
   * unresolved, rather than being matched against a plausible guess.
   */
  directionByRouteId: Map<string, number | null>;
  /**
   * `${routeId}|${directionId}` -> every trip sharing that route+direction,
   * as two PARALLEL typed arrays (trip index, scheduled origin departure
   * seconds) rather than an array of `{tripIdx, originSeconds}` objects
   * (~262k trips share this structure, one object per
   * trip was measured at roughly 15-20 MB, TRANSIENTLY DOUBLED during a
   * feed swap while the old and new `TripLookup` briefly coexist -- real
   * cost on a 4 GB box for a diagnostic-only structure; two `Int32Array`s
   * cost a fraction of that, with no per-entry object header). Used ONLY
   * by the near-miss diagnostic -- never by `resolveJourney`,
   * which stays exact-match-only. A coarser key than `byTripKey` on
   * purpose: the whole point is to find trips whose origin departure is
   * CLOSE to a journey's but not equal to it, which an exact key can never
   * surface by construction.
   */
  byRouteDirection: Map<string, { tripIndices: Int32Array; originSeconds: Int32Array }>;
}

function tripKey(routeId: string, directionId: number, originSeconds: number): string {
  return `${routeId}|${directionId}|${originSeconds}`;
}

function routeDirectionKey(routeId: string, directionId: number): string {
  return `${routeId}|${directionId}`;
}

function pushEntry<K>(map: Map<K, number[]>, key: K, value: number): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

export function buildTripLookup(ix: TimetableIndex): TripLookup {
  const byTripKey = new Map<string, number[]>();
  // Transient plain-number accumulators (one pass, filled by push()), only
  // ever alive during this function's own scan -- converted to compact
  // typed arrays below before being handed back, so the LONG-LIVED
  // structure (what actually survives for a whole poll cycle, and briefly
  // doubles during a feed swap) is the cheap one.
  const rdAccum = new Map<string, { tripIndices: number[]; originSeconds: number[] }>();
  const directionByRouteId = new Map<string, number | null>();
  for (let t = 0; t < ix.nTrips; t++) {
    // t ranges over [0, ix.nTrips) and tripTimeOffset has nTrips + 1
    // entries (index.ts), so both reads below are always in range.
    const from = ix.tripTimeOffset[t]!;
    const to = ix.tripTimeOffset[t + 1]!;
    // A trip with no stop_times has no origin departure to key on -- it
    // cannot be a SIRI journey's match target regardless of route/direction.
    if (from === to) continue;

    // tripRouteIdx[t] is always in range for t < nTrips (Int32Array sized
    // nTrips); its value is -1 (no route) or a valid index into routeIds,
    // never anything else (index.ts sets it from routeIdToIdx.get(...) or
    // leaves the -1 default).
    const routeIdx = ix.tripRouteIdx[t]!;
    if (routeIdx < 0) continue;
    const routeId = ix.routeIds[routeIdx]!;
    const directionId = ix.tripDirection[t]!;
    // The first stop_times row (ordered by stop_sequence at build time, see
    // index.ts) carries the trip's scheduled origin departure, already in
    // "seconds into the service day" -- the same unit GTFS stores it in and
    // the same unit this map's keys use, so no day-context conversion is
    // needed to build the lookup (only `resolveJourney`, converting an
    // absolute epoch, needs one). `from < to` was just established above,
    // so `departureTime[from]` is in range.
    const originSeconds = ix.departureTime[from]!;

    pushEntry(byTripKey, tripKey(routeId, directionId, originSeconds), t);

    const rdKey = routeDirectionKey(routeId, directionId);
    let acc = rdAccum.get(rdKey);
    if (acc === undefined) {
      acc = { tripIndices: [], originSeconds: [] };
      rdAccum.set(rdKey, acc);
    }
    acc.tripIndices.push(t);
    acc.originSeconds.push(originSeconds);

    // `undefined` = not seen yet; a stored `null` = already known ambiguous
    // and must stay that way, which is why this checks `has` rather than
    // treating a `null` read as "not seen".
    if (!directionByRouteId.has(routeId)) directionByRouteId.set(routeId, directionId);
    else if (directionByRouteId.get(routeId) !== directionId) {
      directionByRouteId.set(routeId, null);
    }
  }

  const byRouteDirection = new Map<string, { tripIndices: Int32Array; originSeconds: Int32Array }>();
  for (const [rdKey, acc] of rdAccum) {
    byRouteDirection.set(rdKey, {
      tripIndices: Int32Array.from(acc.tripIndices),
      originSeconds: Int32Array.from(acc.originSeconds),
    });
  }

  const byStopCode = new Map<string, number[]>();
  for (let s = 0; s < ix.nStops; s++) {
    // `?? null`, not `!`: unlike the typed arrays above, `stopCodes` is a
    // plain array, and a test index built by hand (see `testIndex.ts`) can
    // leave it shorter than `nStops` or unset entirely. `!` would coerce a
    // genuine `undefined` hole into the `string | null` type and let it
    // flow into the map as a literal `undefined` key; `?? null` makes that
    // failure loud (no entry for this stop) instead of silent.
    const code = ix.stopCodes[s] ?? null;
    if (code !== null) pushEntry(byStopCode, code, s);
  }

  return { byTripKey, byStopCode, byRouteDirection, directionByRouteId };
}

/** `dataFrameRef` as YYYYMMDD, or `null` if it isn't `YYYY-MM-DD`. Used only
 * to look up a matching `DayContext` by its `dateYmd` -- never fed into date
 * arithmetic here, so a well-formed but impossible date (`"2026-13-45"`)
 * simply matches no real `DayContext` and falls out as unresolved rather
 * than producing `NaN` (that used to be a risk when this file computed a
 * service day's epoch itself; now `DayContext` construction, and any
 * validation of it, is entirely the caller's responsibility). */
function serviceDateYmd(dataFrameRef: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dataFrameRef);
  if (m === null) return null;
  // The regex has exactly 3 capture groups; a successful match guarantees
  // all 3 are present.
  return Number(m[1]!) * 10000 + Number(m[2]!) * 100 + Number(m[3]!);
}

/**
 * How many times the trip's own pattern visits each stop index, for
 * disambiguating a `stop_code` that resolves to more than one physical stop
 * AND for flagging a loop's repeated stops. Reads the trip's pattern rather than its own stop_times slice: every
 * trip in a pattern shares the same stop sequence by construction
 * (`buildPatterns`), so the pattern's stops ARE this trip's stops.
 *
 * A count, not merely a set of which stops occur: `resolveCalls` needs to
 * know not just "is this stop on the trip" (any count >= 1 answers that,
 * same as the old set-based version) but "does the trip revisit this stop"
 * (count > 1) -- a loop pattern that stops at the same physical stop twice,
 * for which a single `expectedArrival` cannot safely be attributed to one
 * specific visit; see `StopPrediction.ambiguous`.
 */
function stopCountsOnTrip(ix: TimetableIndex, tripIdx: number): Map<number, number> {
  // Caller guarantees 0 <= tripIdx < ix.nTrips, so patternOfTrip[tripIdx]
  // is in range, and its value is always a valid pattern index (buildPatterns
  // assigns every trip a pattern), so the offsets below are in range too.
  const p = ix.patternOfTrip[tripIdx]!;
  const from = ix.patternStopOffset[p]!;
  const to = ix.patternStopOffset[p + 1]!;
  const counts = new Map<number, number>();
  for (let i = from; i < to; i++) {
    const s = ix.patternStops[i]!;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/**
 * Resolves each call to a stop index on `tripIdx`'s own pattern. A call is
 * dropped, never guessed at, when its `stop_code` matches no stop on this
 * trip (wrong/stale call) or matches more than one (still ambiguous even
 * after narrowing to this trip's stops -- e.g. a loop route revisiting a
 * duplicated code) -- either way, attaching a prediction to a stop the bus
 * does not (uniquely) stop at is the "wrong bus" outcome the design forbids.
 *
 * A loop route can also visit the SAME resolved stop index twice (two
 * different positions in the pattern, one physical stop), giving two calls
 * for one entry in `byStopIdx`. The rule for WHICH prediction survives, for
 * that one entry: keep the call with the smallest `order` (GTFS
 * `stop_sequence`) -- the soonest upcoming visit, which is the one a rider
 * waiting at that stop right now actually cares about. A call with no
 * `order` is treated as arbitrarily late (loses to any call that does carry
 * one); between two calls that tie (including two both missing `order`),
 * the first one encountered wins, so the rule is total. This is exactly
 * right for the departures board, and must stay exactly as it is for that
 * consumer.
 *
 * It is WRONG for `/plan`, which has a specific pattern position (a leg
 * boards at one particular lap, not "whichever is soonest"). Rather than
 * have this function guess which lap a `/plan` leg
 * meant (silently picking a numeric `order`-vs-position comparison that
 * does not actually hold: this feed's own GTFS `stop_sequence` is 1-based
 * and only 99.97% contiguous per trip, checked against `data/gtfs.sqlite`,
 * while a leg's `stopSequence` is a 0-based PATTERN POSITION -- see
 * `db/shapes.ts`'s `legShapeRefs` doc comment for the same distinction
 * already established elsewhere in this codebase), each entry instead
 * carries `ambiguous: true` whenever `tripIdx`'s OWN pattern visits that
 * stop index more than once. This is computed from the pattern alone,
 * never from which call won "soonest" -- so it is a fact about the TRIP,
 * not an artefact of this tick's data, and it makes the two consumers'
 * needs explicit rather than silently favouring one: `RealtimeStore`
 * exposes both `predictionFor` (ignores `ambiguous`, unchanged behaviour
 * for the departures board) and `unambiguousPredictionFor` (returns `null`
 * when `ambiguous`, for `/plan`).
 */
function resolveCalls(
  ix: TimetableIndex, lookup: TripLookup, tripIdx: number, calls: readonly RealtimeCall[],
): Map<number, StopPrediction> {
  const stopCounts = stopCountsOnTrip(ix, tripIdx);
  const chosenOrder = new Map<number, number>();
  const byStopIdx = new Map<number, StopPrediction>();
  for (const call of calls) {
    const candidates = lookup.byStopCode.get(call.stopCode);
    if (candidates === undefined) continue;
    const onTrip = candidates.filter((s) => stopCounts.has(s));
    if (onTrip.length !== 1) continue;
    const stopIdx = onTrip[0]!;

    const order = call.order ?? Number.POSITIVE_INFINITY;
    const prevOrder = chosenOrder.get(stopIdx);
    if (prevOrder !== undefined && order >= prevOrder) continue;

    chosenOrder.set(stopIdx, order);
    byStopIdx.set(stopIdx, {
      expectedArrival: call.expectedArrival,
      // `!`: stopIdx came from `onTrip`, itself filtered from `candidates`
      // by `stopCounts.has(s)` just above, so `stopCounts.get(stopIdx)` is
      // always present here.
      ambiguous: stopCounts.get(stopIdx)! > 1,
    });
  }
  return byStopIdx;
}

/**
 * Turns a resolved trip, plus the journey that matched it, into per-stop
 * predictions.
 *
 * This is the ONE place the two realtime sources genuinely differ. SIRI-SM
 * carries the operator's own ETA for each stop; SIRI-VM carries a position
 * that must be converted into one. Everything else about resolution -- the
 * trip key, the day filter, the stats, the store -- is shared, so making
 * exactly this step pluggable is what keeps the SIRI-SM path unchanged
 * while a second source runs through the same machinery.
 */
export type PredictionBuilder = (
  ix: TimetableIndex, lookup: TripLookup, tripIdx: number, j: RealtimeJourney,
  day: Pick<DayContext, "baseEpoch" | "activeTrip">,
) => Map<number, StopPrediction>;

/** SIRI-SM: read the ETAs the feed already supplies. Today's behaviour
 *  exactly, and the default for every caller that does not ask otherwise. */
export const predictFromCalls: PredictionBuilder = (ix, lookup, tripIdx, j) =>
  resolveCalls(ix, lookup, tripIdx, j.calls);

/**
 * SIRI-VM: derive one delay from where the vehicle is, then propagate it
 * forward unchanged.
 *
 * Locate `distanceFromStart` between two consecutive stops of the trip,
 * interpolate the scheduled time at that point, and subtract it from
 * `recordedAt`. The resulting delay is applied to every stop AHEAD of the
 * vehicle; stops behind it get nothing at all, because "when will it reach
 * a stop it has already left" is not a question, and a departures board
 * showing a prediction for a stop the bus has passed is worse than one
 * showing none.
 *
 * Constant propagation, with no decay toward the terminus: this is what
 * GTFS-RT itself does for a feed that supplies a delay without per-stop
 * detail, and we have no historical data to fit a recovery curve -- a wrong
 * curve would be worse than no curve.
 *
 * The distance field is trustworthy, not a guess: interpolating it against
 * our own `shape_dist_traveled` reproduces the lat/lon Stride reports for
 * the same vehicle to a median of 60 m (p90 200 m) across 6,288 live rides,
 * so both systems are measuring against the same GTFS shapes.
 */
export const predictFromDistance: PredictionBuilder = (ix, lookup, tripIdx, j, day) => {
  const byStopIdx = new Map<number, StopPrediction>();
  // `null` is "the feed did not say"; 0 is a vehicle sitting at its origin
  // and is a perfectly good input. Distinguishing them is the whole reason
  // `distanceFromStart` is `number | null` rather than defaulting to 0.
  if (j.distanceFromStart === null || j.recordedAt === null) return byStopIdx;

  const from = ix.tripTimeOffset[tripIdx]!;
  const to = ix.tripTimeOffset[tripIdx + 1]!;
  const distance = j.distanceFromStart;

  // Find the segment bracketing the vehicle, skipping positions whose shape
  // distance is absent (-1, 13,169 of 14.8M rows in the current feed).
  // `prev` tracks the last
  // position that HAD a distance, so a gap is stepped over rather than
  // treated as distance 0. A trip with fewer than two usable distances, or a
  // vehicle beyond the last one, falls out with `delaySeconds` still null
  // and produces nothing -- never an extrapolation past the terminus.
  let delaySeconds: number | null = null;
  let scheduledAtVehicle = 0;
  let passedPos = -1;
  let prev = -1;
  let originDistance = -1;
  for (let pos = 0; from + pos < to; pos++) {
    const here = ix.stopDistance[from + pos]!;
    if (here === -1) continue;
    if (originDistance === -1) originDistance = here;
    if (prev !== -1) {
      const before = ix.stopDistance[from + prev]!;
      if (before <= distance && distance <= here) {
        const span = here - before;
        // Two stops at the same shape distance would divide by zero; the
        // vehicle is at that point either way, so anchor on the earlier one.
        const fraction = span === 0 ? 0 : (distance - before) / span;
        const departBefore = ix.departureTime[from + prev]!;
        const arriveHere = ix.arrivalTime[from + pos]!;
        const scheduledHere = departBefore + fraction * (arriveHere - departBefore);
        delaySeconds = Math.round(j.recordedAt - (day.baseEpoch + scheduledHere));
        scheduledAtVehicle = scheduledHere;
        passedPos = prev;
        break;
      }
    }
    prev = pos;
  }
  if (delaySeconds === null) return byStopIdx;
  // A bus still at its origin before its start time is waiting, not early:
  // it leaves on schedule. Without this, a vehicle parked at the terminal
  // five minutes ahead of its slot predicted every stop five minutes early
  // (seen live on 2026-09-13, lines 238 and 2). Only AT the origin -- a bus
  // that has actually left early is a real, if rare, early bus.
  const waitingAtOrigin = distance <= originDistance && delaySeconds < 0;
  if (waitingAtOrigin) delaySeconds = 0;
  // A waiting bus is not falling behind until its start time comes, so that
  // -- not its report -- is when any time lost begins to count.
  const anchorAt = waitingAtOrigin
    ? Math.round(day.baseEpoch + scheduledAtVehicle)
    : j.recordedAt;

  const stopCounts = stopCountsOnTrip(ix, tripIdx);
  // A trip's stop at pattern position `pos`. The index stores stops per
  // PATTERN, not per trip (many trips share one pattern), while times are
  // stored per trip -- but both are indexed by the same position, so
  // `patternStopOffset[p] + pos` and `tripTimeOffset[t] + pos` describe the
  // same stop. This mirrors what `stopCountsOnTrip` just above does.
  const patternFrom = ix.patternStopOffset[ix.patternOfTrip[tripIdx]!]!;

  // Every stop strictly ahead of the segment the vehicle is inside.
  for (let pos = passedPos + 1; from + pos < to; pos++) {
    const stopIdx = ix.patternStops[patternFrom + pos]!;
    // -1 marks a stop_time whose stop was absent from stops.txt (index.ts).
    if (stopIdx < 0) continue;
    byStopIdx.set(stopIdx, {
      expectedArrival: day.baseEpoch + ix.arrivalTime[from + pos]! + delaySeconds,
      // Same rule as `resolveCalls`: a stop this trip's own pattern visits
      // more than once cannot be attributed to one particular lap, so
      // `/plan` must refuse it while `/departures` may still use it.
      ambiguous: (stopCounts.get(stopIdx) ?? 0) > 1,
      anchorAt,
    });
  }
  return byStopIdx;
};

/**
 * Resolves one SIRI journey onto the index by the natural key (route_id,
 * direction_id, scheduled origin departure, service date). Exact
 * match only: any input this function cannot place with certainty (missing
 * origin departure, no trip at that key, more than one trip still active
 * after filtering by day) returns `null` rather than falling back to a
 * nearby line, an approximate time, or an arbitrary same-key trip. Never
 * throws.
 *
 * `day` is the SINGLE `DayContext` this journey's `dataFrameRef` was
 * already matched to -- selecting which of a snapshot's (current day,
 * previous day) contexts applies is `resolveSnapshot`'s job, not this
 * function's, so `resolveJourney` never parses a date itself.
 */
export function resolveJourney(
  lookup: TripLookup, ix: TimetableIndex, j: RealtimeJourney,
  day: Pick<DayContext, "baseEpoch" | "activeTrip">,
  predict: PredictionBuilder = predictFromCalls,
): ResolvedJourney | null {
  if (j.originAimedDeparture === null) return null;

  // `originAimedDeparture` is an absolute epoch; the index's departure
  // times are seconds into a service day, which is a different origin
  // (GTFS noon-minus-12h, not midnight) that shifts on DST transition days.
  // `day.baseEpoch` is that origin for the exact service date this journey
  // named -- computed once per query by `buildDayContexts` (see raptor.ts),
  // the same machinery the planner itself uses, not re-derived here.
  // Subtracting gives seconds into the service day, never modulo'd, so a
  // service that legitimately runs past 86400 (this feed's max is 105787)
  // still compares correctly against `departureTime`.
  const originSeconds = Math.round(j.originAimedDeparture - day.baseEpoch);

  // SIRI-SM always reports a direction (`parseVisit` drops a visit without a
  // DirectionRef); SIRI-VM never does. Recovering it from the route keeps
  // the trip key exactly as exact as it was -- a route carrying two
  // directions yields `null` here and the journey stays unresolved, rather
  // than being matched against a plausible guess.
  const directionId = j.directionId ?? lookup.directionByRouteId.get(j.lineRef) ?? null;
  if (directionId === null) return null;

  const candidates = lookup.byTripKey.get(tripKey(j.lineRef, directionId, originSeconds));
  if (candidates === undefined) return null;

  // The key alone can collide (see TripLookup.byTripKey's comment), but
  // checked feed-wide, filtering to trips active on this specific service
  // day leaves at most one candidate. Exactly one active candidate is a
  // resolution; zero is "no trip of ours ran this route/direction/time
  // today" (unresolved); MORE than one active would mean the day mask does
  // not fully disambiguate the feed after all -- a real property nothing in
  // 261,634 trips has shown so far, so rather than guess among them this
  // treats it the same as zero: unresolved, and worth investigating if
  // `/meta`'s resolution rate ever reflects it.
  const active = candidates.filter((t) => day.activeTrip[t]! === 1);
  if (active.length !== 1) return null;
  const tripIdx = active[0]!;

  return { tripIdx, journey: j, byStopIdx: predict(ix, lookup, tripIdx, j, day) };
}

/**
 * Yields each active slot on the journey's route and direction, paired with
 * its distance from the journey's origin departure. Returns `null` if the
 * journey has no origin departure, no recoverable direction, or no bucket.
 *
 * Shared by `nearestSlot` (pass 2, exact slot matching) and `isNearMiss`
 * (diagnostic: catching timezone/rounding offsets). Both compute origin
 * seconds, recover direction (same fallback for SIRI-VM), look up the
 * route+direction bucket, filter by active-trip, and measure distance;
 * only the aggregation differs (min-distance candidate vs. boolean-any).
 */
function getActiveSlots(
  lookup: TripLookup, j: RealtimeJourney, day: Pick<DayContext, "baseEpoch" | "activeTrip">,
): { tripIdx: number; originSeconds: number; distance: number }[] | null {
  if (j.originAimedDeparture === null) return null;
  const originSeconds = Math.round(j.originAimedDeparture - day.baseEpoch);
  const directionId = j.directionId ?? lookup.directionByRouteId.get(j.lineRef) ?? null;
  if (directionId === null) return null;
  const bucket = lookup.byRouteDirection.get(routeDirectionKey(j.lineRef, directionId));
  if (bucket === undefined) return null;

  const slots: { tripIdx: number; originSeconds: number; distance: number }[] = [];
  for (let i = 0; i < bucket.tripIndices.length; i++) {
    const tripIdx = bucket.tripIndices[i]!;
    if (day.activeTrip[tripIdx] !== 1) continue;
    const slot = bucket.originSeconds[i]!;
    const distance = Math.abs(slot - originSeconds);
    slots.push({ tripIdx, originSeconds: slot, distance });
  }
  return slots;
}

/**
 * The nearest active slot on the journey's route and direction within
 * `SLOT_WINDOW_SECONDS`, or `null` when the exact slot itself is ambiguous.
 *
 * Pass 1 fails at distance 0 for exactly one reason: `resolveJourney`'s "more
 * than one active candidate" rule found two or more trips sharing this exact
 * key. That is pass 1's own ambiguity, not an absence of a slot -- and pass 2
 * must not paper over it by quietly returning some OTHER slot a few minutes
 * away just because that neighbour happens to be alone. Before this guarded
 * against it, a journey landing exactly on two trips' shared start time could
 * be silently attached to (or made an unscheduled run of) a third, unrelated
 * trip minutes off, which is a worse wrong-bus outcome than staying
 * unresolved. So ANY active slot at distance 0 -- not
 * merely the nearest one -- makes the whole call `null`; the caller's
 * `isNearMiss` diagnostic still sees these slots via `getActiveSlots`.
 */
function nearestSlot(
  lookup: TripLookup, j: RealtimeJourney, day: Pick<DayContext, "baseEpoch" | "activeTrip">,
): { tripIdx: number; originSeconds: number; distance: number } | null {
  const slots = getActiveSlots(lookup, j, day);
  if (slots === null) return null;
  if (slots.some((slot) => slot.distance === 0)) return null;
  let best: { tripIdx: number; originSeconds: number; distance: number } | null = null;
  for (const slot of slots) {
    if (slot.distance > SLOT_WINDOW_SECONDS) continue;
    if (best === null || slot.distance < best.distance) best = slot;
  }
  return best;
}

/**
 * Resolves every journey in a snapshot, routing each to the `DayContext`
 * its own `dataFrameRef` names (matched by `dateYmd`) rather than assuming
 * "today". `days` is expected to be the current service day and the
 * previous one (`buildDayContexts`'s own return shape) -- a SIRI snapshot
 * can carry a trip that started late last night and is still running, so
 * both must be offered. A journey whose `dataFrameRef` is missing,
 * malformed, or names a date not among `days` is unresolved: it is never
 * matched against an arbitrary day just because one happens to be
 * available.
 *
 * A journey that misses pass 1 gets a second pass: the nearest
 * active slot on its route and direction within `SLOT_WINDOW_SECONDS`. An
 * empty slot takes the bus as that trip; a slot that already has a bus makes
 * it an `UnscheduledRun` timed from that trip shifted by the start offset.
 */
export function resolveSnapshot(
  lookup: TripLookup, ix: TimetableIndex,
  journeys: readonly RealtimeJourney[], days: readonly DayContext[],
  predict: PredictionBuilder = predictFromCalls,
): { resolved: ResolvedJourney[]; unscheduled: UnscheduledRun[]; stats: MatchStats } {
  const resolved: ResolvedJourney[] = [];
  const pending: { j: RealtimeJourney; day: DayContext; slot: { tripIdx: number; originSeconds: number; distance: number }; order: number }[] = [];
  const unmatched: { j: RealtimeJourney; day: DayContext | null }[] = [];

  // Pass 1: exact, exactly as before.
  journeys.forEach((j, order) => {
    const day = selectDay(days, j.dataFrameRef);
    const r = day === null ? null : resolveJourney(lookup, ix, j, day, predict);
    if (r !== null) { resolved.push(r); return; }
    const slot = day === null ? null : nearestSlot(lookup, j, day);
    if (day === null || slot === null) { unmatched.push({ j, day }); return; }
    pending.push({ j, day, slot, order });
  });

  // Pass 2: nearest first, so when two buses want one empty slot the closer
  // one gets it; ties by vehicle then input order, so the result is stable.
  pending.sort((a, b) => a.slot.distance - b.slot.distance
    || (a.j.vehicleRef ?? "").localeCompare(b.j.vehicleRef ?? "")
    || a.order - b.order);
  const claimed = new Set(resolved.map((r) => r.tripIdx));
  const unscheduled: UnscheduledRun[] = [];
  let attached = 0;
  for (const { j, day, slot } of pending) {
    if (!claimed.has(slot.tripIdx)) {
      // An empty slot: this bus IS that run, retimed. Predicted against the
      // slot's own times, so the offset reads as delay -- which is what it
      // is to a rider waiting for that slot.
      claimed.add(slot.tripIdx);
      resolved.push({ tripIdx: slot.tripIdx, journey: j, byStopIdx: predict(ix, lookup, slot.tripIdx, j, day) });
      attached++;
      continue;
    }
    // `pending` only holds journeys with an origin departure (nearestSlot
    // returned null otherwise).
    const offsetSeconds = Math.round(j.originAimedDeparture! - (day.baseEpoch + slot.originSeconds));
    const shifted = { baseEpoch: day.baseEpoch + offsetSeconds, activeTrip: day.activeTrip };
    unscheduled.push({
      templateTripIdx: slot.tripIdx,
      offsetSeconds,
      serviceBaseEpoch: day.baseEpoch,
      journey: j,
      byStopIdx: predict(ix, lookup, slot.tripIdx, j, shifted),
    });
  }

  let nearMissCount = 0;
  for (const { j, day } of unmatched) {
    if (day !== null && isNearMiss(lookup, j, day)) nearMissCount++;
  }
  return {
    resolved,
    unscheduled,
    stats: {
      resolved: resolved.length,
      unresolved: unmatched.length,
      resolvedWithNoCalls: resolved.filter((r) => r.byStopIdx.size === 0).length,
      nearMissCount,
      attached,
      unscheduled: unscheduled.length,
    },
  };
}

/** Seconds a journey still unmatched after BOTH passes may miss a slot by
 * and still count as a near miss. Pass 2 now matches everything within
 * `SLOT_WINDOW_SECONDS`, so the old 300 s would read 0 forever; an hour keeps
 * the counter saying whether that window is too tight. Diagnostic only. */
const NEAR_MISS_TOLERANCE_SECONDS = 3600;

/**
 * True when `j` did not resolve to an exact trip (the caller already knows
 * this -- see `resolveSnapshot`), but SOME trip sharing its route,
 * direction and day exists whose own scheduled origin departure is within
 * `NEAR_MISS_TOLERANCE_SECONDS` of `j`'s -- without being an exact match
 * (an exact-key, exact-day match that still somehow failed to resolve, per
 * `resolveJourney`'s own "more than one active candidate" comment, has
 * never been observed on this feed and is not what this diagnostic is
 * for). Purely additive: this function is never called from
 * `resolveJourney`, only from `resolveSnapshot` AFTER a journey is already
 * known to be unresolved, so it cannot influence resolution itself, only
 * describe how close a miss was.
 *
 * A single boolean, not a distance: the diagnostic value is "how many
 * unresolved journeys were suspiciously close", which answers "is the join
 * key wrong by a constant offset, or wrong entirely" -- the exact offset,
 * if this ever needs to be more precise, is a job
 * for a captured real payload, not for a live counter on a public `/meta`.
 */
function isNearMiss(
  lookup: TripLookup, j: RealtimeJourney, day: Pick<DayContext, "baseEpoch" | "activeTrip">,
): boolean {
  const slots = getActiveSlots(lookup, j, day);
  if (slots === null) return false;
  for (const slot of slots) {
    if (slot.distance > 0 && slot.distance <= NEAR_MISS_TOLERANCE_SECONDS) return true;
  }
  return false;
}

function selectDay(days: readonly DayContext[], dataFrameRef: string | null): DayContext | null {
  if (dataFrameRef === null) return null;
  const ymd = serviceDateYmd(dataFrameRef);
  if (ymd === null) return null;
  return days.find((d) => d.dateYmd === ymd) ?? null;
}
