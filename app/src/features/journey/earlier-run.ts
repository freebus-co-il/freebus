import type { Itinerary, TransitAlternative, TransitLeg } from '@/api/types';
import { earlierOptions, withLineChosen } from '@/features/trip/line-options';

const epochMs = (iso: string) => new Date(iso).getTime();

/**
 * The run a rider who set out early can actually catch: the LAST one leaving
 * before the planned ride that they can still be at the stop for.
 *
 * `readyAtMs` is when they reach the boarding stop -- now plus the walk still
 * ahead of them. A run that left before that is not a candidate however
 * tempting: they were not there.
 *
 * Null when nothing earlier is catchable, which is the ordinary case and
 * means the plan stands exactly as searched.
 */
export function catchableEarlierRun(leg: TransitLeg, readyAtMs: number): TransitAlternative | null {
  // `earlierOptions` is closest-first, so the first match is the latest run
  // before the planned one -- the one with the most slack to reach.
  return earlierOptions(leg).find((option) => epochMs(option.from.departureTime) >= readyAtMs) ?? null;
}

/**
 * The run the rider is on, when the evidence says they boarded before the
 * planned bus: the most recent earlier run that has already left.
 *
 * Deliberately NOT "the nearest departure to now": a run still ahead of the
 * rider cannot be carrying them. The caller decides that they ARE aboard --
 * from GPS moving along the route while the planned bus has not left -- and
 * this only says which run that must be.
 */
export function boardedEarlierRun(leg: TransitLeg, nowMs: number): TransitAlternative | null {
  return earlierOptions(leg).find((option) => epochMs(option.from.departureTime) <= nowMs) ?? null;
}

/**
 * The journey as it should actually begin, for a rider pressing Start before
 * the plan told them to leave: on the earliest run they can still walk to,
 * rather than on the bus a search from half an hour ago picked.
 *
 * The walk still ahead of them is what decides "can still": the rider is here,
 * now, and the stop is a few minutes away. The rest of the plan is untouched
 * -- same stops, same route, same onward rides -- so the only thing that
 * changes is which run of that line carries them, and the arrival that follows
 * from it.
 */
export function withEarlierRunAtStart(itinerary: Itinerary, nowMs: number): Itinerary {
  const rideIndex = itinerary.legs.findIndex((leg) => leg.type === 'transit');
  if (rideIndex < 0) return itinerary;

  const walkSecondsAhead = itinerary.legs
    .slice(0, rideIndex)
    .reduce((total, leg) => total + (leg.type === 'walk' ? leg.durationSeconds : 0), 0);

  const run = catchableEarlierRun(itinerary.legs[rideIndex] as TransitLeg, nowMs + walkSecondsAhead * 1000);
  if (run === null) return itinerary;
  return withLineChosen(itinerary, rideIndex, run.tripId) ?? itinerary;
}
