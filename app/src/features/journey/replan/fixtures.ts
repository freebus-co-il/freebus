import type { Itinerary, Leg, Place, TransitLeg, WalkLeg } from '@/api/types';

/** Test-only builders for the re-planning core. Times are ISO strings on one
 *  fixed morning; places sit on a line so distances are easy to reason about. */

const BASE = Date.parse('2026-10-23T08:00:00.000Z');

/** Minutes after 08:00 as an ISO string. */
export const t = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();
export const ms = (minutes: number): number => BASE + minutes * 60_000;

/** A stop `metersNorth` metres due north of a fixed origin. */
export function stop(stopId: string, metersNorth = 0, name = stopId): Place {
  return { type: 'stop', stopId, name, lat: 32 + metersNorth / 111_320, lon: 34.8 };
}

export function ride(opts: {
  routeType?: number;
  line?: string;
  tripId?: string;
  from: Place;
  to: Place;
  dep: number;
  arr: number;
}): TransitLeg {
  const line = opts.line ?? 'L';
  return {
    type: 'transit',
    route: { id: `r-${line}`, agencyId: '3', shortName: line, longName: '', type: opts.routeType ?? 3, color: null },
    tripId: opts.tripId ?? `trip-${line}-${opts.dep}`,
    headsign: 'Somewhere',
    directionId: 0,
    from: { stop: opts.from, departureTime: t(opts.dep), stopSequence: 1 },
    to: { stop: opts.to, arrivalTime: t(opts.arr), stopSequence: 5 },
    numStops: 4,
    intermediateStops: [],
    geometry: null,
    geometryFallback: false,
    realtime: null,
  };
}

export function walk(from: Place, to: Place, minutes = 5): WalkLeg {
  return {
    type: 'walk',
    from,
    to,
    distanceMeters: minutes * 80,
    durationSeconds: minutes * 60,
    geometry: null,
    walkEstimated: false,
  };
}

export function itin(legs: Leg[], dep?: number, arr?: number): Itinerary {
  const rides = legs.filter((leg): leg is TransitLeg => leg.type === 'transit');
  const departureTime = dep !== undefined ? t(dep) : rides[0]?.from.departureTime ?? t(0);
  const arrivalTime = arr !== undefined ? t(arr) : rides[rides.length - 1]?.to.arrivalTime ?? t(0);
  return {
    departureTime,
    arrivalTime,
    durationSeconds: (Date.parse(arrivalTime) - Date.parse(departureTime)) / 1000,
    transfers: Math.max(0, rides.length - 1),
    walkSeconds: 0,
    walkMeters: 0,
    transferAtRisk: null,
    legs,
  };
}
