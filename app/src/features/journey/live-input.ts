import type { CheckedLeg, JourneyCheckResponse } from '@/api/journey-check';
import type { LiveVehicle, TransitLeg, TripDetail } from '@/api/types';

import { legBusProgress } from './live-bus';
import type { LiveBus, LiveJourneyInput } from './types';

/**
 * A `/journey/check` answer, mapped from request positions back onto the
 * itinerary. A leg whose trip id does not match what was asked at that
 * position is dropped: that is a response to a different chain (a stale
 * cache entry from before a leg was completed), and applying it would pin one
 * bus's prediction onto another.
 */
export function liveFromCheck(
  response: JourneyCheckResponse,
  checked: readonly CheckedLeg[],
  fetchedAt: string,
): Pick<LiveJourneyInput, 'legs' | 'connections'> {
  const legs: LiveJourneyInput['legs'] = [];
  response.legs.forEach((leg, index) => {
    const asked = checked[index];
    if (!asked || asked.leg.tripId !== leg.tripId) return;
    legs.push({
      legIndex: asked.legIndex,
      predictedDeparture: leg.from.predicted ? leg.from.departure : null,
      predictedArrival: leg.to.predicted ? leg.to.arrival : null,
      fetchedAt,
    });
  });
  // The same guard, on both ends of a connection. A response can outlive the
  // chain it answered -- it is kept on screen while a new chain is fetched, so
  // the prediction is not lost the moment a leg is completed -- and then
  // position 0 names a different leg. A verdict about what follows t1 must
  // never become a verdict about what follows t2.
  const askedMatches = (position: number) =>
    checked[position] !== undefined && checked[position]!.leg.tripId === response.legs[position]?.tripId;
  const connections = response.connections.flatMap((connection) => {
    const asked = checked[connection.afterLeg];
    if (!asked || !askedMatches(connection.afterLeg) || !askedMatches(connection.afterLeg + 1)) return [];
    return [{ afterLegIndex: asked.legIndex, holds: connection.holds, fetchedAt }];
  });
  return { legs, connections };
}

/** The bus on `leg`, placed against the rider's own boarding and alighting
 *  stops. Null until both the trip's stop list and a position are in hand. */
export function liveBusFrom(
  legIndex: number,
  leg: TransitLeg,
  trip: TripDetail | undefined,
  vehicle: LiveVehicle | null,
  now: Date,
): LiveBus | null {
  if (!trip || !vehicle) return null;
  return {
    legIndex,
    progress: legBusProgress(trip, leg, vehicle, now),
    recordedAt: vehicle.recordedAt,
    lat: vehicle.lat,
    lon: vehicle.lon,
  };
}
