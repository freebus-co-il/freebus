import type { TimetableIndex } from "./index.js";
import type { DayContext } from "./raptor.js";
import type { Lang, Translator } from "../db/i18n.js";
import type { TransitLeg } from "./itinerary.js";
import { toIso } from "./calendar.js";

/**
 * The same route shape `TransitLeg.route` uses -- a type-only alias, not a
 * duplicate declaration, so the public `/segments` route field can never
 * silently diverge from a transit leg's own. Mirrors `routes/departures.ts`'s
 * `DepartureRealtime` alias for the identical reason.
 */
export type SegmentRoute = TransitLeg["route"];

export interface SegmentDeparture {
  tripId: string;
  route: SegmentRoute;
  /** See `TransitLeg.headsign`. */
  headsign: string | null;
  /** See `TransitLeg.tripNumber`. */
  tripNumber: string | null;
  directionId: number;
  /** ISO-8601 with offset, at the segment's `from` stop. */
  departureTime: string;
  /** ISO-8601 with offset, at the segment's `to` stop. */
  arrivalTime: string;
  durationSeconds: number;
  /** Stops between `from` and `to`, matching a transit leg's own field. */
  numStops: number;
}

/**
 * One (pattern, boarding position, alighting position) candidate, together
 * with the day it was found active on -- kept only long enough to be turned
 * into a `SegmentDeparture` once every candidate across every pattern and
 * day has been gathered and merge-sorted by departure epoch.
 */
interface Candidate {
  tripIdx: number;
  fromPos: number;
  toPos: number;
  departEpoch: number;
  arrivalEpoch: number;
}

/**
 * Every trip that serves `fromIdx` then `toIdx`, in that order, ordered by
 * departure time -- a LOOKUP over the in-memory RAPTOR index (`ix.
 * stopPatterns`/`ix.patternStops`/`ix.patternTrips`), not a search: no
 * headway margin, no reachability, no Pareto set. See routes/segments.ts for
 * the full contract this implements.
 *
 * For each pattern serving `fromIdx`, every VISIT to that stop is its own
 * candidate boarding position -- a loop pattern can visit the same stop
 * twice, and each visit pairs with the nearest later visit of `toIdx` in
 * that same pattern, never an earlier one. A pattern that never visits
 * `toIdx` after any visit of `fromIdx` contributes nothing.
 *
 * Each candidate contributes AT MOST `resultsLimit` trips per day -- never a
 * clock-bounded window. A flat forward window (three hours, say) would
 * starve any pair whose next departure happens to fall
 * outside it, which is routine for a low-frequency intercity pair queried
 * mid-morning: measured on the real feed, 401 of 1,414 low-frequency pairs
 * with Monday service returned an empty board at 09:00 despite having a
 * departure later that same day. `resultsLimit` per candidate is the
 * correct bound instead, because the final merge below only ever keeps the
 * earliest `resultsLimit` overall -- no candidate can contribute more than
 * that to the answer, so collecting more than that from any one of them is
 * wasted work, and collecting fewer would risk missing a departure that
 * belongs in the answer. This makes the whole scan O(resultsLimit x
 * candidates), never a function of how far away the next departure happens
 * to be.
 *
 * `days` is exactly the `DayContext[]` `buildDayContexts` produces --
 * today's service day and the previous one, so a trip that departed
 * yesterday at 25:30 and is still running now is found the same way `/plan`
 * and the departures board find it. Each day is searched independently --
 * every `DayContext` carries its own `baseEpoch` (so the same GTFS second
 * means a different absolute instant on each) and its own `activeTrip` mask
 * (so a trip active on one day may not be on the other) -- and every day's
 * and every pattern's candidates are merged by absolute epoch before
 * `resultsLimit` is applied, so a later pattern cannot be starved by an
 * earlier one that happened to be scanned first.
 */
export function findSegments(
  ix: TimetableIndex,
  days: readonly DayContext[],
  fromIdx: number,
  toIdx: number,
  afterEpoch: number,
  ctx: { tr: Translator; lang: Lang; tz: string; routeOf: (routeIdx: number) => SegmentRoute },
  opts: { resultsLimit: number },
): SegmentDeparture[] {
  const candidates: Candidate[] = [];

  // The range of `ix.stopPatterns`/`stopPatternPos` entries for the FROM
  // stop -- one entry per (pattern, visit) pair, NOT a stop index itself
  // (that's `fromIdx`/`toIdx`, fixed for the whole call).
  const visitsStart = ix.stopPatternOffset[fromIdx]!;
  const visitsEnd = ix.stopPatternOffset[fromIdx + 1]!;

  for (let i = visitsStart; i < visitsEnd; i++) {
    const p = ix.stopPatterns[i]!;
    const fromPos = ix.stopPatternPos[i]!;

    const patStopFrom = ix.patternStopOffset[p]!;
    const patStopTo = ix.patternStopOffset[p + 1]!;
    const patLen = patStopTo - patStopFrom;

    // The nearest later visit of `toIdx` in this same pattern -- never an
    // earlier one (excluded by starting the scan at fromPos + 1) and never
    // a farther one when a nearer visit exists (the first match wins).
    let toPos = -1;
    for (let j = fromPos + 1; j < patLen; j++) {
      if (ix.patternStops[patStopFrom + j]! === toIdx) { toPos = j; break; }
    }
    if (toPos < 0) continue;

    const tripFrom = ix.patternTripOffset[p]!;
    const tripTo = ix.patternTripOffset[p + 1]!;

    for (const day of days) {
      const target = afterEpoch - day.baseEpoch;

      let lo = tripFrom;
      let hi = tripTo;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const trip = ix.patternTrips[mid]!;
        const dep = ix.departureTime[ix.tripTimeOffset[trip]! + fromPos]!;
        if (dep >= target) hi = mid; else lo = mid + 1;
      }

      // Walk forward collecting active trips, up to `resultsLimit` for THIS
      // candidate -- more than that can never survive the final merge (see
      // the function doc comment) -- with the pattern's own remaining trips
      // for the day as the only other bound, not a clock.
      let collected = 0;
      for (let k = lo; k < tripTo && collected < opts.resultsLimit; k++) {
        const trip = ix.patternTrips[k]!;
        if (day.activeTrip[trip] !== 1) continue;
        const dep = ix.departureTime[ix.tripTimeOffset[trip]! + fromPos]!;
        const arr = ix.arrivalTime[ix.tripTimeOffset[trip]! + toPos]!;
        candidates.push({
          tripIdx: trip, fromPos, toPos,
          departEpoch: day.baseEpoch + dep,
          arrivalEpoch: day.baseEpoch + arr,
        });
        collected++;
      }
    }
  }

  // Entries arrive grouped per (pattern, day), each already ordered within
  // itself, but not against each other -- a final sort across everything is
  // required before `resultsLimit` can be applied, exactly as
  // `db/departures.ts`'s `departuresAt` does for its own per-stop-day merge.
  // The sort must run over EVERY candidate before the slice, not the other
  // way around -- truncating first (or stopping the outer pattern loop
  // early once enough candidates exist) can drop a genuinely-earliest
  // departure that happened to live in a pattern scanned late.
  candidates.sort((a, b) => a.departEpoch - b.departEpoch);

  return candidates.slice(0, opts.resultsLimit).map((c) => ({
    tripId: ix.tripIds[c.tripIdx]!,
    route: ctx.routeOf(ix.tripRouteIdx[c.tripIdx]!),
    headsign: ctx.tr.resolve(ix.tripHeadsigns[c.tripIdx] ?? null, ctx.lang),
    tripNumber: ix.tripNumbers[c.tripIdx] ?? null,
    directionId: ix.tripDirection[c.tripIdx]!,
    departureTime: toIso(c.departEpoch, ctx.tz),
    arrivalTime: toIso(c.arrivalEpoch, ctx.tz),
    durationSeconds: c.arrivalEpoch - c.departEpoch,
    numStops: c.toPos - c.fromPos,
  }));
}
