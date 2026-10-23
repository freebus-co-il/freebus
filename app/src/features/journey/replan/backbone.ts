import type { Itinerary, Place, TransitLeg } from '@/api/types';
import { haversineMeters } from '@/lib/geo';

/**
 * A started trip keeps its backbone and nothing else: the ride the rider
 * would least want swapped -- its kind of vehicle and the two stations it
 * runs between. Which bus gets them to it, which run they catch, and how
 * they walk are all free to change as the journey re-plans itself.
 */

export type ModeFamily = 'rail' | 'bus' | 'other';

/** GTFS route types, basic and extended, grouped the way a rider thinks of
 *  them: on rails, on the road, or something else. */
export function modeFamily(routeType: number): ModeFamily {
  if ([0, 1, 2, 5, 7, 12].includes(routeType)) return 'rail';
  if ((routeType >= 100 && routeType <= 199) || (routeType >= 400 && routeType <= 499) || (routeType >= 900 && routeType <= 999)) {
    return 'rail';
  }
  if (routeType === 3 || routeType === 11 || (routeType >= 700 && routeType <= 799)) return 'bus';
  return 'other';
}

/** Rail outranks anything else, and anything else outranks a bus: a rider who
 *  picked a train picked it on purpose, while buses are the interchangeable
 *  part of most trips. */
const MODE_RANK: Record<ModeFamily, number> = { rail: 2, other: 1, bus: 0 };

export type StationRef = { stopId: string | null; lat: number; lon: number; name: string | null };

export type Backbone = { mode: ModeFamily; board: StationRef; alight: StationRef };

/** Within this, two stops are one station: platforms of one rail station, the
 *  two sides of a street, a terminal's bays. */
export const SAME_STATION_METERS = 250;

export function stationOf(place: Place): StationRef {
  return { stopId: place.stopId ?? null, lat: place.lat, lon: place.lon, name: place.name ?? null };
}

export function sameStation(a: StationRef, b: StationRef): boolean {
  if (a.stopId !== null && a.stopId === b.stopId) return true;
  return haversineMeters(a, b) <= SAME_STATION_METERS;
}

function rideSeconds(leg: TransitLeg): number {
  return (Date.parse(leg.to.arrivalTime) - Date.parse(leg.from.departureTime)) / 1000;
}

export function backboneOf(itinerary: Itinerary): { backbone: Backbone; legIndex: number } | null {
  let best: { leg: TransitLeg; legIndex: number } | null = null;
  itinerary.legs.forEach((leg, legIndex) => {
    if (leg.type !== 'transit') return;
    if (best === null) {
      best = { leg, legIndex };
      return;
    }
    const rank = MODE_RANK[modeFamily(leg.route.type)];
    const bestRank = MODE_RANK[modeFamily(best.leg.route.type)];
    if (rank > bestRank || (rank === bestRank && rideSeconds(leg) > rideSeconds(best.leg))) {
      best = { leg, legIndex };
    }
  });
  if (best === null) return null;
  const { leg, legIndex } = best as { leg: TransitLeg; legIndex: number };
  return {
    legIndex,
    backbone: { mode: modeFamily(leg.route.type), board: stationOf(leg.from.stop), alight: stationOf(leg.to.stop) },
  };
}

export function respectsBackbone(candidate: Itinerary, backbone: Backbone): boolean {
  return candidate.legs.some(
    (leg) =>
      leg.type === 'transit' &&
      modeFamily(leg.route.type) === backbone.mode &&
      sameStation(stationOf(leg.from.stop), backbone.board) &&
      sameStation(stationOf(leg.to.stop), backbone.alight),
  );
}
