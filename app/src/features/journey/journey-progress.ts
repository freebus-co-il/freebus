import type { Itinerary, Leg } from '@/api/types';
import { haversineMeters } from '@/lib/geo';
import { decodePolyline } from '@/lib/polyline';

type Point = { lat: number; lon: number };

/** Standing at the place a leg ends: the stop a walk leads to, the stop a
 *  ride is got off at, the destination. The machine's boarding radius, so
 *  "at the stop" means one thing everywhere. */
export const AT_PLACE_RADIUS_METERS = 100;

/** Close enough to a leg's route to be travelling it. A bus's reported shape
 *  and a phone's fix each drift a few tens of metres off the road. */
export const ON_PATH_METERS = 75;

/** Far enough from the current leg's route that the rider is plainly not on
 *  it any more -- the threshold for looking further along the journey. */
export const OFF_PATH_METERS = 250;

const METERS_PER_DEGREE = 111_320;

/** The route a leg travels: its drawn geometry, or the straight lines between
 *  its own points when the feed published none. */
export function legPath(leg: Leg): Point[] {
  if (leg.geometry) {
    const decoded = decodePolyline(leg.geometry).map(([lat, lon]) => ({ lat, lon }));
    if (decoded.length >= 2) return decoded;
  }
  return leg.type === 'walk' ? [leg.from, leg.to] : [leg.from.stop, ...leg.intermediateStops, leg.to.stop];
}

/** Metres from a point to the nearest place on a path, projected flat around
 *  the point -- exact enough at the scale of a city. */
export function distanceToPathMeters(point: Point, path: Point[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return haversineMeters(point, path[0]!);
  const metersPerLon = METERS_PER_DEGREE * Math.cos((point.lat * Math.PI) / 180);
  const project = (p: Point) => ({ x: (p.lon - point.lon) * metersPerLon, y: (p.lat - point.lat) * METERS_PER_DEGREE });

  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = project(path[index]!);
    const b = project(path[index + 1]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(a.x + along * dx, a.y + along * dy));
  }
  return best;
}

/**
 * Whether the rider has finished a leg: standing where it ends. For a ride,
 * that place also has to be the nearest of the ride's stops -- the stop
 * before it can sit inside the radius on a short hop, and being there is
 * still riding.
 */
function hasFinished(leg: Leg, point: Point): boolean {
  if (leg.type === 'walk') return haversineMeters(point, leg.to) <= AT_PLACE_RADIUS_METERS;
  const toAlight = haversineMeters(point, leg.to.stop);
  if (toAlight > AT_PLACE_RADIUS_METERS) return false;
  return [leg.from.stop, ...leg.intermediateStops].every((stop) => haversineMeters(point, stop) >= toAlight);
}

/** Where a first fix puts the rider: on the leg the timetable expects if they
 *  are on its route, else on whichever leg's route they are nearest to, else
 *  -- on none of them -- where the timetable expects after all. */
function place(legs: Leg[], expected: number, point: Point): number {
  const distances = legs.map((leg) => distanceToPathMeters(point, legPath(leg)));
  if ((distances[expected] ?? Number.POSITIVE_INFINITY) <= ON_PATH_METERS) return expected;
  let best = expected;
  let bestDistance = ON_PATH_METERS;
  distances.forEach((distance, index) => {
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** A rider well off the current leg's route but on a later one's got there
 *  unseen -- the app was closed, the fixes starved -- and is placed there.
 *  Ties go to the later leg: where two legs meet, the rider has moved on. */
function skipAhead(legs: Leg[], current: number, point: Point): number {
  if (distanceToPathMeters(point, legPath(legs[current]!)) <= OFF_PATH_METERS) return current;
  let best = current;
  let bestDistance = ON_PATH_METERS;
  for (let index = current + 1; index < legs.length; index += 1) {
    const distance = distanceToPathMeters(point, legPath(legs[index]!));
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The leg GPS puts the rider on -- `itinerary.legs.length` once they have
 * reached the destination -- or null while no usable fix has ever placed
 * them, which leaves the journey to the timetable.
 *
 * Moves only forward, and only on evidence: a leg is finished by standing
 * where it ends, not by its scheduled minutes running out, so a slow walk
 * stays a walk and a late bus stays a ride. Without a fix the last placement
 * simply holds.
 *
 * @param previous the placement so far, from the journey record
 * @param fix the rider's position, already judged good enough to act on
 * @param expected the leg the timetable puts the rider on, for a first fix
 */
export function trackLegIndex(
  itinerary: Itinerary,
  previous: number | null,
  fix: Point | null,
  expected: number,
): number | null {
  const { legs } = itinerary;
  if (fix === null || legs.length === 0) return previous;
  if (previous !== null && previous >= legs.length) return legs.length;

  let index = previous === null
    ? place(legs, Math.min(Math.max(expected, 0), legs.length - 1), fix)
    : skipAhead(legs, previous, fix);
  while (index < legs.length && hasFinished(legs[index]!, fix)) index += 1;
  return previous === null ? index : Math.max(previous, index);
}

/**
 * The leg a journey's geofence proves the rider has reached, from the
 * region's id (see `buildJourneyRegions`): at a ride's boarding stop they are
 * on that ride; at its alight stop they are past it; at the destination the
 * journey is done. The wake ring proves nothing new -- the ride is already
 * under way by then.
 */
export function reachedFromRegion(itinerary: Itinerary, regionId: string): number | null {
  const [kind, rawLegIndex] = regionId.split(':');
  if (kind === 'destination') return itinerary.legs.length;
  const legIndex = Number(rawLegIndex);
  if (!Number.isInteger(legIndex) || itinerary.legs[legIndex]?.type !== 'transit') return null;
  if (kind === 'board') return legIndex;
  if (kind === 'alight') return legIndex + 1;
  return null;
}
