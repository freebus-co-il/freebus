import type { Itinerary, Leg, TransitLeg } from '@/api/types';

import type { JourneyState, RiderPosition } from '../types';

/**
 * Re-planning answers "from here to the destination", so applying it means
 * keeping what the rider has already done -- and the ride they are sitting on
 * -- and putting the new way after it. Keeping the done legs keeps every
 * leg-indexed piece of the journey (GPS progress, alerts already acknowledged,
 * the progress rail) pointing at the same legs.
 */

/** A fix older than this, or vaguer than `FIX_ACCURACY_METERS`, does not say
 *  where the rider is now. */
const FIX_FRESH_MS = 60_000;
const FIX_ACCURACY_METERS = 100;

function isTransit(leg: Leg): leg is TransitLeg {
  return leg.type === 'transit';
}

export function spliceItinerary(current: Itinerary, keepThroughLegIndex: number, replacement: Itinerary): Itinerary {
  const kept = current.legs.slice(0, keepThroughLegIndex + 1);
  const legs = [...kept, ...replacement.legs];
  const departureTime = kept.length > 0 ? current.departureTime : replacement.departureTime;
  const arrivalTime = replacement.arrivalTime;
  const walks = legs.filter((leg) => leg.type === 'walk');
  return {
    ...replacement,
    legs,
    departureTime,
    arrivalTime,
    durationSeconds: (Date.parse(arrivalTime) - Date.parse(departureTime)) / 1000,
    transfers: Math.max(0, legs.filter(isTransit).length - 1),
    walkSeconds: walks.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    walkMeters: walks.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    transferAtRisk: replacement.transferAtRisk,
  };
}

/** Where a re-plan starts from, and how much of the current itinerary it
 *  leaves in place. Null when there is nothing left to plan. */
export function replanOriginFor(
  state: JourneyState,
  itinerary: Itinerary,
  position: RiderPosition | null,
  nowMs: number,
): { from: string; departAfter?: string; keepThroughLegIndex: number } | null {
  if (state.phase === 'arriving' || state.phase === 'arrived') return null;

  if (state.phase === 'riding' || state.phase === 'alight-soon') {
    // The ride under the rider stays to its own alighting stop; only what comes
    // after it is re-planned, from that stop, at when the bus gets there.
    const leg = itinerary.legs[state.legIndex];
    if (!leg || !isTransit(leg) || !leg.to.stop.stopId) return null;
    return {
      from: `stop:${leg.to.stop.stopId}`,
      departAfter: leg.realtime?.predictedArrival ?? leg.to.arrivalTime,
      keepThroughLegIndex: state.legIndex,
    };
  }

  const keepThroughLegIndex = state.legIndex - 1;
  const usable =
    position !== null &&
    position.accuracyMeters <= FIX_ACCURACY_METERS &&
    nowMs - Date.parse(position.at) <= FIX_FRESH_MS;
  if (usable) return { from: `${position.lat},${position.lon}`, keepThroughLegIndex };

  const nextRide = itinerary.legs.slice(state.legIndex).find(isTransit);
  if (!nextRide?.from.stop.stopId) return null;
  // Still walking there: plan from the stop at when the walk gets the rider
  // to it, or a bus leaving it in a minute would look catchable.
  const walking = itinerary.legs[state.legIndex];
  const departAfter = walking?.type === 'walk'
    ? new Date(nowMs + walking.durationSeconds * 1000).toISOString()
    : undefined;
  return departAfter
    ? { from: `stop:${nextRide.from.stop.stopId}`, departAfter, keepThroughLegIndex }
    : { from: `stop:${nextRide.from.stop.stopId}`, keepThroughLegIndex };
}
