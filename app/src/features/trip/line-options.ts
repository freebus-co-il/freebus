import type { Itinerary, TransitAlternative, TransitLeg } from '@/api/types';

const epochMs = (iso: string) => new Date(iso).getTime();

/** How much sooner or later a line has to get the rider there before it is
 *  worth telling them. Under this, two lines are as good as each other. */
export const NOTABLE_ARRIVAL_DIFFERENCE_SECONDS = 3 * 60;

/**
 * Every line the rider could take for this ride -- the planned one and the
 * server's alternatives -- in departure order. The planned one carries the
 * baseline the alternatives were measured against: no missed connection, no
 * delay (or, once the rider has switched, the values of the one they took).
 */
export function lineOptions(leg: TransitLeg): TransitAlternative[] {
  const { alternatives = [], ...planned } = leg;
  const current: TransitAlternative = {
    ...planned,
    missesConnection: leg.missesConnection ?? false,
    arrivalDelaySeconds: leg.arrivalDelaySeconds === undefined ? 0 : leg.arrivalDelaySeconds,
  };
  return [current, ...alternatives.filter((option) => option.tripId !== leg.tripId)]
    .sort((a, b) => epochMs(a.from.departureTime) - epochMs(b.from.departureTime));
}

/** What taking `option` instead of `current` does to the rider's journey. */
export type LineVerdict =
  | { kind: 'slower'; minutesLater: number }
  | { kind: 'sooner'; minutesSooner: number }
  /** It misses the connection and the server found no onward trip to say how
   *  much later that makes the rider -- the only case with no minutes to show. */
  | { kind: 'misses' }
  | { kind: 'same' };

/**
 * Judged by when the rider reaches the END of the journey, not by the ride
 * itself. A bus that misses the connection is simply later by however long the
 * next connection takes -- the server re-plans onwards from where it drops the
 * rider -- so it reads as "+N min" like any other slower bus, and a slower bus
 * that still makes the same train costs nothing, so it is `same`. Both sides'
 * delays are against the ride originally planned, so the difference is what
 * switching from `current` to `option` costs.
 */
export function lineVerdict(option: TransitAlternative, current: TransitAlternative): LineVerdict {
  const later = option.arrivalDelaySeconds == null || current.arrivalDelaySeconds == null
    ? null
    : option.arrivalDelaySeconds - current.arrivalDelaySeconds;

  if (later === null) {
    return option.missesConnection && !current.missesConnection ? { kind: 'misses' } : { kind: 'same' };
  }
  if (later >= NOTABLE_ARRIVAL_DIFFERENCE_SECONDS) return { kind: 'slower', minutesLater: Math.round(later / 60) };
  if (later <= -NOTABLE_ARRIVAL_DIFFERENCE_SECONDS) return { kind: 'sooner', minutesSooner: Math.round(-later / 60) };
  return { kind: 'same' };
}

/**
 * Only the runs at or after the planned one -- the trip screen's "Or later".
 * That list is a fallback for a rider who is late or whose bus never came, so
 * a run that has already gone has no business in it.
 */
export function laterOptions(leg: TransitLeg): TransitAlternative[] {
  const planned = epochMs(leg.from.departureTime);
  return lineOptions(leg).filter((option) => epochMs(option.from.departureTime) >= planned);
}

/**
 * The runs BEFORE the planned one, closest first: what a rider who set out
 * early is actually sitting on. The server offers one per route (see
 * `alternatives.ts`), so this is a short list of real candidates.
 */
export function earlierOptions(leg: TransitLeg): TransitAlternative[] {
  const planned = epochMs(leg.from.departureTime);
  return lineOptions(leg)
    .filter((option) => epochMs(option.from.departureTime) < planned)
    .reverse();
}

/** The ride's own option out of `lineOptions`. */
export function currentOption(leg: TransitLeg, options: TransitAlternative[] = lineOptions(leg)): TransitAlternative {
  return options.find((option) => option.tripId === leg.tripId)!;
}

/**
 * The other LINES that do at least as well as this ride's own -- shown
 * together as "70 / 10 / 202". One entry per line. A line that gets the rider there
 * meaningfully later -- whether it is slower or misses the connection -- is a
 * fallback, not an equal, so it is left out here.
 */
export function equallyGoodLines(leg: TransitLeg): TransitAlternative[] {
  const options = lineOptions(leg);
  const current = currentOption(leg, options);
  const seen = new Set([leg.route.id]);
  return options.filter((option) => {
    if (seen.has(option.route.id)) return false;
    const { kind } = lineVerdict(option, current);
    if (kind !== 'same' && kind !== 'sooner') return false;
    seen.add(option.route.id);
    return true;
  });
}

/**
 * The itinerary with the ride at `legIndex` taken on `tripId` instead: the
 * chosen option becomes the leg, and every other option -- the one it
 * replaces included -- becomes its alternatives, so the rider can change their
 * mind back.
 *
 * Every option boards and alights at the leg's own stops, so the walks around
 * it stay right. Only the ends of the journey can move: a first ride that
 * leaves earlier or later moves when the rider has to set out, and a last one
 * moves when they arrive. A middle ride that misses its connection leaves the
 * rest of the plan behind; the running journey reads that as a missed transfer
 * and offers a new route from there.
 *
 * Null when there is nothing to change: not a ride, already on that trip, or
 * a trip that is not one of its options.
 */
export function withLineChosen(itinerary: Itinerary, legIndex: number, tripId: string): Itinerary | null {
  const leg = itinerary.legs[legIndex];
  if (!leg || leg.type !== 'transit' || leg.tripId === tripId) return null;
  const options = lineOptions(leg);
  const chosen = options.find((option) => option.tripId === tripId);
  if (!chosen) return null;

  const legs = itinerary.legs.slice();
  legs[legIndex] = { ...chosen, alternatives: options.filter((option) => option.tripId !== tripId) };

  const transitIndexes = legs.flatMap((l, index) => (l.type === 'transit' ? [index] : []));
  const departureShift = legIndex === transitIndexes[0]
    ? epochMs(chosen.from.departureTime) - epochMs(leg.from.departureTime)
    : 0;
  const arrivalShift = legIndex === transitIndexes[transitIndexes.length - 1]
    ? epochMs(chosen.to.arrivalTime) - epochMs(leg.to.arrivalTime)
    : 0;
  const departure = epochMs(itinerary.departureTime) + departureShift;
  const arrival = epochMs(itinerary.arrivalTime) + arrivalShift;

  return {
    ...itinerary,
    legs,
    departureTime: departureShift === 0 ? itinerary.departureTime : new Date(departure).toISOString(),
    arrivalTime: arrivalShift === 0 ? itinerary.arrivalTime : new Date(arrival).toISOString(),
    durationSeconds: Math.round((arrival - departure) / 1000),
  };
}
