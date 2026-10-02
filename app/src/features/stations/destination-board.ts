import type { Departure } from '@/api/types';

import { departureKey } from './station-line';

/**
 * The row that gets the rider to the destination first -- but ONLY when the
 * board's own order does not already say so.
 *
 * A filtered board stays in departure order, because that is the order the
 * buses pull in and the rider is standing at the kerb watching for them. The
 * cost of that is a slow bus leaving now and an express leaving in ten
 * minutes that overtakes it: nothing on a time-ordered board hints that the
 * row further down arrives sooner.
 *
 * So this marks that row, and nothing else. When the first bus to leave is
 * also the first to arrive there is no such trap, and a mark that is always
 * on says nothing -- it would sit on the top row of nearly every board and
 * be read as decoration rather than as the warning it is.
 *
 * Returns a `departureKey`, or null when there is nothing to warn about.
 */
export function fastestArrivalKey(departures: readonly Departure[]): string | null {
  // An API older than the destination field annotates nothing; so does a
  // board that was never filtered. Either way there is no arrival to compare.
  const timed = departures.filter((d) => d.destination !== undefined);
  if (timed.length < 2) return null;

  let best = timed[0]!;
  let bestAt = Date.parse(best.destination!.arrivalTime);
  for (const departure of timed.slice(1)) {
    const at = Date.parse(departure.destination!.arrivalTime);
    // Strictly earlier, so a tie goes to the bus that leaves first -- which
    // is the one the rider can board soonest, and which needs no mark.
    if (at < bestAt) {
      best = departure;
      bestAt = at;
    }
  }

  // The first row to leave is also the first to arrive: the board is already
  // telling the truth in the only order it has.
  return best === timed[0] ? null : departureKey(best);
}
