import { legsToCheck, type CheckedLeg } from '@/api/journey-check';
import type { TransitLeg } from '@/api/types';

import { vehicleInPlay } from './journey-labels';
import type { ActiveJourney, JourneyState } from './types';

export type LiveRequestPlan = {
  /** The transit legs `/journey/check` is asked about, in journey order. */
  checked: CheckedLeg[];
  /** The query key for that chain: a new chain is a new question. */
  checkKey: string;
  /** The vehicle whose position is polled, if any. */
  ride: TransitLeg | null;
  rideIndex: number;
  /** Whether a bus is worth asking about at all, before the hook's own
   *  visible and realtime gates. */
  wantsBus: boolean;
};

/**
 * What to ask the server about, from the state resolved WITHOUT live input.
 *
 * Pure and split out of `useJourneyLive` so the seam between the machine and
 * the network is testable without React: every bug found here so far was a
 * question the hook forgot to ask, not an answer it misread.
 *
 * On a transfer walk the chain starts at the ride just finished, not at the
 * walk: the connection the walk is racing is indexed after that ride, so
 * leaving it out would mean a broken transfer could never be seen while
 * walking to it.
 *
 * The bus is wanted whenever there is a vehicle in play, whatever phase the
 * base state reads. The base knows nothing live, so a rider at the stop past
 * the timetable's grace reads as off-plan there -- which is precisely when the
 * bus's position is what can overrule it.
 */
export function liveRequestPlan(journey: ActiveJourney | null, base: JourneyState | null): LiveRequestPlan {
  if (!journey) return { checked: [], checkKey: ':', ride: null, rideIndex: -1, wantsBus: false };

  const { legs } = journey.itinerary;
  const fromLegIndex = chainStart(journey, base);
  const checked = legsToCheck(journey.itinerary, fromLegIndex);
  // The trip ids too: a rider who says they are on another line keeps the same
  // leg indexes, and a key of indexes alone would go on reusing the answer
  // about the bus they are not on.
  const checkKey = `${journey.id}:${checked.map((c) => `${c.legIndex}=${c.leg.tripId}`).join(',')}`;

  const ride = base ? vehicleInPlay(journey.itinerary, base) : null;
  const rideIndex = ride ? legs.indexOf(ride) : -1;
  return { checked, checkKey, ride, rideIndex, wantsBus: ride !== null };
}

function chainStart(journey: ActiveJourney, base: JourneyState | null): number {
  if (!base) return 0;
  const { legs } = journey.itinerary;
  // Only a walk BETWEEN rides reaches back: the first walk has nothing behind
  // it, and the final one has no connection left to protect.
  const walkingBetweenRides = legs[base.legIndex]?.type === 'walk' && base.phase === 'transferring';
  if (!walkingBetweenRides) return base.legIndex;
  for (let legIndex = base.legIndex - 1; legIndex >= 0; legIndex -= 1) {
    if (legs[legIndex]?.type === 'transit') return legIndex;
  }
  return base.legIndex;
}
