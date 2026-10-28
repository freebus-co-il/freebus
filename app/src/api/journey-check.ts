import type { Itinerary, TransitLeg } from './types';

/** One end of a checked leg. `predicted` is the only reliable live/scheduled
 *  signal: the server reports `delaySeconds: 0` both for a bus that is on time
 *  and for one it knows nothing about. */
type JourneyCheckEnd = { stopId: string; name: string | null; delaySeconds: number; predicted: boolean };

export type JourneyCheckLeg = {
  tripId: string;
  from: JourneyCheckEnd & { scheduledDeparture: string; departure: string };
  to: JourneyCheckEnd & { scheduledArrival: string; arrival: string };
};

/** `afterLeg` indexes the REQUEST's legs, not the itinerary's. */
export type JourneyCheckConnection = {
  afterLeg: number;
  slackSeconds: number;
  requiredSeconds: number;
  /** Three-valued: null means "cannot say", and must never be read as false. */
  holds: boolean | null;
};

/** `GET /journey/check`. */
export type JourneyCheckResponse = {
  at: string;
  legs: JourneyCheckLeg[];
  connections: JourneyCheckConnection[];
  arrivalTime: string;
  holds: boolean | null;
};

/** A transit leg as asked about, remembering where it sits in the itinerary so
 *  the response can be mapped back. */
export type CheckedLeg = { legIndex: number; leg: TransitLeg };

/** The server's own cap on legs per request. */
export const MAX_CHECK_LEGS = 12;

/**
 * The transit legs still worth asking about, from `fromLegIndex` on.
 *
 * Stops at the first leg with a missing stop id rather than skipping it: the
 * response's `connections[].afterLeg` indexes the request, and a gap in the
 * middle would pair two legs that are not actually consecutive.
 */
export function legsToCheck(itinerary: Itinerary, fromLegIndex: number): CheckedLeg[] {
  const checked: CheckedLeg[] = [];
  for (let legIndex = Math.max(0, fromLegIndex); legIndex < itinerary.legs.length; legIndex += 1) {
    const leg = itinerary.legs[legIndex];
    if (!leg || leg.type !== 'transit') continue;
    if (!leg.from.stop.stopId || !leg.to.stop.stopId) break;
    checked.push({ legIndex, leg });
    if (checked.length === MAX_CHECK_LEGS) break;
  }
  return checked;
}

/**
 * Built by hand because `apiGet`'s params go through `URLSearchParams.set`,
 * which cannot repeat a key -- and `leg` is repeated, in journey order.
 */
export function journeyCheckPath(legs: readonly CheckedLeg[], lang: string): string {
  const params = legs.map(
    ({ leg }) => `leg=${encodeURIComponent(`${leg.tripId},${leg.from.stop.stopId},${leg.to.stop.stopId}`)}`,
  );
  params.push(`lang=${encodeURIComponent(lang)}`);
  return `/journey/check?${params.join('&')}`;
}
