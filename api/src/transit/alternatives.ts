import type { TimetableIndex } from "./index.js";
import type { DayContext } from "./raptor.js";
import type { Lang, Translator } from "../db/i18n.js";
import {
  transitLegOf, type Itinerary, type Leg, type TransitAlternative, type TransitLeg,
} from "./itinerary.js";

/**
 * The later buses a ride can also be taken on -- for a rider who is late, or
 * whose bus never comes -- each with what taking it does to their arrival.
 *
 * An alternative for a transit leg is another trip that boards at the leg's
 * own board stop and calls, later on the same trip, at the leg's own alight
 * stop, leaving no earlier than the planned ride and at most
 * `laterDepartureSeconds` after it. Same two stops on purpose: every walk leg
 * around the ride stays exactly right, so a client can swap the alternative in
 * for the leg without re-planning anything else. The planned line's own next
 * trip counts -- "the next 852" is the most common fallback there is. One trip
 * per route, the first after the planned ride, so the list reads as lines.
 *
 * Nothing is dropped for being slow. What a rider needs is to see that it is:
 *  - `missesConnection` -- it reaches the alight stop too late (after the walk
 *    and the boarding buffer) for the planned next ride;
 *  - `arrivalDelaySeconds` -- how much later the rider reaches the END of the
 *    itinerary taking it, against the planned ride. Both are measured the same
 *    way: follow the itinerary's own stops onwards and take the earliest-
 *    arriving trip, on any route, on every later ride. So a slower bus that
 *    still makes the same train costs nothing, a bus that misses it costs the
 *    wait for the next one, and on a final ride the difference is the ride
 *    itself. Negative when it gets the rider there sooner. When those stops
 *    have no onward trip left, `replanArrival` plans afresh from where the bus
 *    drops the rider; null only when even that finds nothing.
 *
 * The buffer is the flat `transferMinSeconds`, not the planner's headway-scaled
 * margin: a connection the flat rule makes is one `/plan` itself would offer
 * (see the merged relaxed search in `routes/plan.ts`).
 */
export interface AlternativesOptions {
  tr: Translator;
  lang: Lang;
  tz: string;
  routeOf: (routeIdx: number) => TransitLeg["route"];
  transferMinSeconds: number;
  laterDepartureSeconds: number;
  /**
   * How far BEFORE the planned ride an alternative may leave -- for a rider
   * who set out earlier than the plan told them to and caught the run before
   * it. One per route, the LAST one before the planned ride, because that is
   * the one an early rider actually catches; anything before it they have
   * already missed by the time they are looking.
   */
  earlierDepartureSeconds: number;
  maxPerLeg: number;
  /** The request's own mode/wheelchair filter, so an alternative never breaks it. */
  tripFilter?: (tripIdx: number) => boolean;
  /**
   * The rider's arrival at the destination if they are at stop `stopIdx` at
   * `readyEpoch` and plan afresh from there -- any route, any stops, walking
   * included -- or null. Asked only when following the itinerary's own stops
   * onwards finds no trip (the last train on that pair has gone, say), so a
   * bus that misses its connection still gets a real "+N min" instead of none.
   */
  replanArrival?: (stopIdx: number, readyEpoch: number) => number | null;
}

interface Ride {
  tripIdx: number; boardPos: number; alightPos: number;
  departureEpoch: number; arrivalEpoch: number;
}

const epochOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** Fills `alternatives` on every transit leg of every itinerary, in place. */
export function annotateAlternatives(
  ix: TimetableIndex, days: readonly DayContext[],
  itineraries: readonly Itinerary[], opts: AlternativesOptions,
): void {
  for (const itinerary of itineraries) {
    itinerary.legs.forEach((leg, i) => {
      if (leg.type !== "transit") return;
      leg.alternatives = opts.maxPerLeg <= 0 ? [] : alternativesFor(ix, days, itinerary.legs, i, opts);
    });
  }
}

/** The pattern position of `alight` after `boardPos` on pattern `p`, or -1. */
function alightPosition(ix: TimetableIndex, p: number, boardPos: number, alight: number): number {
  const stopFrom = ix.patternStopOffset[p]!;
  const patternLength = ix.patternStopOffset[p + 1]! - stopFrom;
  for (let pos = boardPos + 1; pos < patternLength; pos++) {
    if (ix.patternStops[stopFrom + pos] === alight) return pos;
  }
  return -1;
}

function alternativesFor(
  ix: TimetableIndex, days: readonly DayContext[], legs: readonly Leg[], i: number,
  opts: AlternativesOptions,
): TransitAlternative[] {
  const leg = legs[i] as TransitLeg;
  const board = ix.stopIdToIdx.get(leg.from.stop.stopId ?? "");
  const alight = ix.stopIdToIdx.get(leg.to.stop.stopId ?? "");
  const chosenTrip = ix.tripIdToIdx.get(leg.tripId);
  if (board === undefined || alight === undefined || chosenTrip === undefined) return [];

  const plannedBoardEpoch = epochOf(leg.from.departureTime);
  const earliestBoardEpoch = plannedBoardEpoch - opts.earlierDepartureSeconds;
  const latestBoardEpoch = plannedBoardEpoch + opts.laterDepartureSeconds;

  /** Per route, the first run at or after the planned ride: the fallback for a
   *  rider who is late or whose bus never came. */
  const firstByRoute = new Map<number, Ride>();
  /** Per route, the last run BEFORE it: what a rider who set out early caught. */
  const lastEarlierByRoute = new Map<number, Ride>();
  // Every pattern visit of the board stop -- a loop pattern lists the stop
  // once per visit, and each visit is its own boarding position.
  for (let k = ix.stopPatternOffset[board]!; k < ix.stopPatternOffset[board + 1]!; k++) {
    const p = ix.stopPatterns[k]!;
    const boardPos = ix.stopPatternPos[k]!;
    const alightPos = alightPosition(ix, p, boardPos, alight);
    if (alightPos < 0) continue;

    for (const day of days) {
      for (let j = ix.patternTripOffset[p]!; j < ix.patternTripOffset[p + 1]!; j++) {
        const t = ix.patternTrips[j]!;
        const times = ix.tripTimeOffset[t]!;
        const departureEpoch = day.baseEpoch + ix.departureTime[times + boardPos]!;
        // A pattern's trips are ordered at every stop (see
        // `PatternSet.patternTrips`), so nothing later in it leaves in time.
        if (departureEpoch > latestBoardEpoch) break;
        if (departureEpoch < earliestBoardEpoch) continue;
        if (t === chosenTrip || day.activeTrip[t] !== 1) continue;
        if (opts.tripFilter !== undefined && !opts.tripFilter(t)) continue;

        const arrivalEpoch = day.baseEpoch + ix.arrivalTime[times + alightPos]!;
        const route = ix.tripRouteIdx[t]!;
        const candidate = { tripIdx: t, boardPos, alightPos, departureEpoch, arrivalEpoch };

        if (departureEpoch < plannedBoardEpoch) {
          // The LATEST earlier run wins: the closest one before the planned
          // ride is the one an early rider is on, and the ones before that are
          // long gone.
          const kept = lastEarlierByRoute.get(route);
          if (kept === undefined || departureEpoch > kept.departureEpoch
              || (departureEpoch === kept.departureEpoch && arrivalEpoch < kept.arrivalEpoch)) {
            lastEarlierByRoute.set(route, candidate);
          }
          continue;
        }

        const kept = firstByRoute.get(route);
        if (kept === undefined || departureEpoch < kept.departureEpoch
            || (departureEpoch === kept.departureEpoch && arrivalEpoch < kept.arrivalEpoch)) {
          firstByRoute.set(route, candidate);
        }
      }
    }
  }
  // Each side is capped on its own, so a crowd of earlier runs can never
  // squeeze out the later fallbacks -- the two answer different questions.
  const earlier = [...lastEarlierByRoute.values()]
    .sort((a, b) => b.departureEpoch - a.departureEpoch || a.arrivalEpoch - b.arrivalEpoch || a.tripIdx - b.tripIdx)
    .slice(0, opts.maxPerLeg);
  if (firstByRoute.size === 0 && earlier.length === 0) return [];

  // What the planned ride leads to, measured the same way as every alternative
  // -- never the itinerary's own arrival, whose onward rides the planner may
  // have picked by effort rather than by arrival.
  const plannedEnd = arrivalAtEnd(ix, days, legs, i, alight, epochOf(leg.to.arrivalTime), opts);
  const next = nextRide(legs, i);

  const later = [...firstByRoute.values()]
    .sort((a, b) => a.departureEpoch - b.departureEpoch || a.arrivalEpoch - b.arrivalEpoch || a.tripIdx - b.tripIdx)
    .slice(0, opts.maxPerLeg);

  return [...earlier, ...later]
    .sort((a, b) => a.departureEpoch - b.departureEpoch || a.arrivalEpoch - b.arrivalEpoch || a.tripIdx - b.tripIdx)
    .map((ride) => {
      const end = arrivalAtEnd(ix, days, legs, i, alight, ride.arrivalEpoch, opts);
      return {
        ...transitLegOf(
          ix, ride.tripIdx, ride.boardPos, ride.alightPos, ride.departureEpoch, ride.arrivalEpoch, opts),
        missesConnection: next !== null
          && ride.arrivalEpoch + next.walkSeconds + opts.transferMinSeconds
            > epochOf(next.leg.from.departureTime),
        arrivalDelaySeconds: end === null || plannedEnd === null ? null : end - plannedEnd,
      };
    });
}

/** `endOfJourney` along the itinerary's own stops, else a fresh plan from the alight stop. */
function arrivalAtEnd(
  ix: TimetableIndex, days: readonly DayContext[], legs: readonly Leg[], i: number,
  alight: number, alightEpoch: number, opts: AlternativesOptions,
): number | null {
  return endOfJourney(ix, days, legs, i, alightEpoch, opts)
    ?? opts.replanArrival?.(alight, alightEpoch)
    ?? null;
}

/** The next ride after leg `i`, and the walking between the two. */
function nextRide(legs: readonly Leg[], i: number): { leg: TransitLeg; walkSeconds: number } | null {
  let walkSeconds = 0;
  for (let j = i + 1; j < legs.length; j++) {
    const l = legs[j]!;
    if (l.type === "transit") return { leg: l, walkSeconds };
    walkSeconds += l.durationSeconds;
  }
  return null;
}

/**
 * When the rider reaches the end of the itinerary if they get off ride `i` at
 * `alightEpoch`: every later walk as planned, and every later ride on the
 * earliest-arriving trip -- any route -- between that ride's own two stops that
 * they can still board. Null when some later ride has no such trip.
 */
function endOfJourney(
  ix: TimetableIndex, days: readonly DayContext[], legs: readonly Leg[], i: number,
  alightEpoch: number, opts: AlternativesOptions,
): number | null {
  let at = alightEpoch;
  for (let j = i + 1; j < legs.length; j++) {
    const l = legs[j]!;
    if (l.type === "walk") { at += l.durationSeconds; continue; }
    const board = ix.stopIdToIdx.get(l.from.stop.stopId ?? "");
    const alight = ix.stopIdToIdx.get(l.to.stop.stopId ?? "");
    if (board === undefined || alight === undefined) return null;
    const arrival = earliestArrival(ix, days, board, alight, at + opts.transferMinSeconds, opts.tripFilter);
    if (arrival === null) return null;
    at = arrival;
  }
  return at;
}

/** The earliest arrival at `alight` on any trip boarding `board` at or after `readyEpoch`. */
function earliestArrival(
  ix: TimetableIndex, days: readonly DayContext[], board: number, alight: number,
  readyEpoch: number, tripFilter?: (tripIdx: number) => boolean,
): number | null {
  let best: number | null = null;
  for (let k = ix.stopPatternOffset[board]!; k < ix.stopPatternOffset[board + 1]!; k++) {
    const p = ix.stopPatterns[k]!;
    const boardPos = ix.stopPatternPos[k]!;
    const alightPos = alightPosition(ix, p, boardPos, alight);
    if (alightPos < 0) continue;

    for (const day of days) {
      // Binary search for the first trip leaving at or after `readyEpoch`;
      // departures are ordered at every stop of a pattern.
      let lo = ix.patternTripOffset[p]!;
      let hi = ix.patternTripOffset[p + 1]!;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const t = ix.patternTrips[mid]!;
        if (day.baseEpoch + ix.departureTime[ix.tripTimeOffset[t]! + boardPos]! < readyEpoch) lo = mid + 1;
        else hi = mid;
      }
      for (let j = lo; j < ix.patternTripOffset[p + 1]!; j++) {
        const t = ix.patternTrips[j]!;
        if (day.activeTrip[t] !== 1) continue;
        if (tripFilter !== undefined && !tripFilter(t)) continue;
        // The first running trip arrives earliest in this pattern: arrivals are
        // ordered too.
        const arrival = day.baseEpoch + ix.arrivalTime[ix.tripTimeOffset[t]! + alightPos]!;
        if (best === null || arrival < best) best = arrival;
        break;
      }
    }
  }
  return best;
}
