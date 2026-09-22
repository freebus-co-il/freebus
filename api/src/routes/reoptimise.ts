import { runRaptorReverse, type ReverseQuery } from "../transit/raptorReverse.js";
import { reconstructReverseChain, type Itinerary } from "../transit/itinerary.js";
import type { Label } from "../transit/raptor.js";
import type { TimetableIndex } from "../transit/index.js";
import { toIso } from "../transit/calendar.js";

/**
 * The latest instant a traveller can leave the origin and still make this
 * itinerary: the first transit leg's boarding time, less every walk leg
 * before it.
 *
 * Without this the reported departure is the QUERY INSTANT, because the
 * forward pass seeds its access labels at `departAfterEpoch` -- so a 07:00
 * query for an 08:00 train reported "07:00 -> 08:10, 70 min", burying an hour
 * of platform waiting inside `durationSeconds`.
 *
 * Null for a walk-only itinerary: there is no boarding to work back from, and
 * its existing anchoring is already correct.
 */
export function doorDepartureEpoch(itinerary: Itinerary): number | null {
  let walkBefore = 0;
  for (const leg of itinerary.legs) {
    if (leg.type === "walk") { walkBefore += leg.durationSeconds; continue; }
    return Math.floor(Date.parse(leg.from.departureTime) / 1000) - walkBefore;
  }
  return null;
}

/**
 * A copy anchored on the door departure. The legs are NOT touched -- their
 * own times were always correct; only the itinerary-level anchor was wrong.
 */
export function reanchorDeparture(itinerary: Itinerary, tz: string): Itinerary {
  const door = doorDepartureEpoch(itinerary);
  if (door === null) return itinerary;
  const arrival = Math.floor(Date.parse(itinerary.arrivalTime) / 1000);
  return {
    ...itinerary,
    departureTime: toIso(door, tz),
    durationSeconds: Math.max(0, arrival - door),
  };
}

export interface ReoptimiseDeps {
  ix: TimetableIndex;
  /** The same query the forward pass used, minus the two fields set per call. */
  reverseQuery: Omit<ReverseQuery, "arriveByEpoch" | "maxRounds">;
  buildFrom: (chain: { stopIdx: number; label: Label }[]) => Itinerary;
  tz: string;
}

/**
 * The latest departure achieving this itinerary's arrival, found by running
 * the existing reverse pass backwards from that arrival.
 *
 * This reuses machinery already validated against a brute-force oracle over
 * 200,000 random networks rather than adding a second departure-optimising
 * algorithm that would need its own verification.
 *
 * The replacement is adopted only when arrival and transfer count are EXACTLY
 * equal. Equality rather than "no worse" is deliberate: a fewer-transfer
 * result would be better on both axes, but it would then occupy another
 * Pareto member's coordinates and the two could collapse into duplicates in
 * the returned list. A genuinely fewer-transfer journey is already a separate
 * member produced by the forward pass's own round structure.
 *
 * A walk-only itinerary (`doorDepartureEpoch` null: no transit leg at all) is
 * returned unchanged. There is nothing to re-board, and `transfers` collapses
 * "zero transit legs" and "one transit leg" to the same value (0) -- so
 * without this guard a reverse search run against a walk-only itinerary could
 * in principle surface an unrelated one-trip transit journey that happens to
 * share both the arrival instant and a transfer count of 0.
 */
export function reoptimiseItinerary(
  itinerary: Itinerary, deps: ReoptimiseDeps,
): Itinerary {
  if (doorDepartureEpoch(itinerary) === null) return itinerary;

  const arrivalEpoch = Math.floor(Date.parse(itinerary.arrivalTime) / 1000);
  const rounds = itinerary.transfers + 1;

  const reverse = runRaptorReverse(deps.ix, {
    ...deps.reverseQuery,
    arriveByEpoch: arrivalEpoch,
    maxRounds: rounds,
  });

  let best = itinerary;
  let bestDeparture = Date.parse(itinerary.departureTime) / 1000;

  for (const origin of deps.reverseQuery.origins) {
    const chain = reconstructReverseChain(deps.ix, reverse.rounds, rounds, origin.stopIdx);
    if (chain === null) continue;

    const candidate = reanchorDeparture(deps.buildFrom(chain), deps.tz);
    if (candidate.arrivalTime !== itinerary.arrivalTime) continue;
    if (candidate.transfers !== itinerary.transfers) continue;

    const departure = Date.parse(candidate.departureTime) / 1000;
    if (departure > bestDeparture) { best = candidate; bestDeparture = departure; }
  }

  return best;
}

/**
 * Re-anchor ALWAYS; reoptimise only the first `limit` itineraries of a
 * response.
 *
 * The two steps are separated here rather than in the route handler so the
 * invariant is a property of one function that a test can pin: whatever the
 * bound, an itinerary NEVER goes back to reporting the query instant. Only
 * the "could the traveller leave even later for this same arrival?"
 * refinement — the second reverse RAPTOR pass, which is what actually costs —
 * is skipped past the bound.
 *
 * `position` is the itinerary's 0-based index in `paretoRounds`'s own
 * fewest-transfers-first push order INSIDE ONE `search()` CALL, at the moment
 * this function runs — NOT its final position in the `/plan` response.
 * `routes/plan.ts` ranks (reorders AND filters) the merged result of every
 * `search()` call only after this has already run for each one, so which
 * itineraries kept their reoptimisation and which member effort ranking
 * eventually puts first are unrelated: a candidate this function left past
 * `limit` can rank first in the response the rider actually sees, and it is
 * exactly that candidate — the one that skipped the "could the traveller
 * leave even later for this same arrival?" refinement — that ends up on top.
 * Re-anchoring is unaffected either way: it is unconditional regardless of
 * `position`, so no itinerary regresses to reporting the query instant no
 * matter where ranking later puts it. Bounding by search-time position
 * (rather than, say, reoptimising every itinerary effort ranking might keep)
 * remains the right trade for cost reasons — see
 * `planConfig.reoptimiseMaxItineraries` for the measurements — it just no
 * longer doubles as "the ones a client renders at the top".
 *
 * `limit` of 0 disables reoptimisation entirely and still re-anchors.
 */
export function reoptimiseBounded(
  position: number, limit: number, raw: Itinerary, deps: ReoptimiseDeps,
): Itinerary {
  const anchored = reanchorDeparture(raw, deps.tz);
  return position < limit ? reoptimiseItinerary(anchored, deps) : anchored;
}
