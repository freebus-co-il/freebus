import type { WalkManeuver, WalkStep } from '@/api/types';
import { haversineMeters } from '@/lib/geo';

export type Point = { lat: number; lon: number };

const METERS_PER_DEGREE = 111_320;

/** Further than this from the walk's line, the rider has left it. A phone's
 *  fix on a city street drifts a few tens of metres; a wrong turn goes further. */
export const OFF_ROUTE_METERS = 40;

/** Within this of a turn, the rider is at it: the banner moves on to the one
 *  after, rather than saying "turn right in 0 m" while they are turning. */
export const AT_MANEUVER_METERS = 8;

/** How far ahead along the path the heading is read from, so one kink in the
 *  street's line does not swing the map. */
const HEADING_LOOKAHEAD_METERS = 15;

/** Metres from the path's start to each of its points. */
export function cumulativeMeters(path: Point[]): number[] {
  const cumulative = [0];
  for (let index = 1; index < path.length; index += 1) {
    cumulative.push(cumulative[index - 1]! + haversineMeters(path[index - 1]!, path[index]!));
  }
  return cumulative;
}

export type PathProjection = {
  /** How far the point is from the path. */
  offsetMeters: number;
  /** How far along the path its nearest place is. */
  alongMeters: number;
};

/** The nearest place on `path` to `point`, measured flat around the point --
 *  exact enough at the scale of a walk. */
export function projectOntoPath(
  point: Point, path: Point[], cumulative: number[] = cumulativeMeters(path),
): PathProjection | null {
  if (path.length === 0) return null;
  if (path.length === 1) return { offsetMeters: haversineMeters(point, path[0]!), alongMeters: 0 };
  const metersPerLon = METERS_PER_DEGREE * Math.cos((point.lat * Math.PI) / 180);
  const project = (p: Point) => ({ x: (p.lon - point.lon) * metersPerLon, y: (p.lat - point.lat) * METERS_PER_DEGREE });

  let best: PathProjection = { offsetMeters: Number.POSITIVE_INFINITY, alongMeters: 0 };
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = project(path[index]!);
    const b = project(path[index + 1]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    const offset = Math.hypot(a.x + fraction * dx, a.y + fraction * dy);
    if (offset < best.offsetMeters) {
      const segment = cumulative[index + 1]! - cumulative[index]!;
      best = { offsetMeters: offset, alongMeters: cumulative[index]! + fraction * segment };
    }
  }
  return best;
}

/** The place `meters` along the path, clamped to its ends. */
export function pointAlong(path: Point[], meters: number, cumulative: number[] = cumulativeMeters(path)): Point {
  if (path.length === 1 || meters <= 0) return path[0]!;
  const total = cumulative[cumulative.length - 1]!;
  if (meters >= total) return path[path.length - 1]!;
  let index = 1;
  while (cumulative[index]! < meters) index += 1;
  const start = cumulative[index - 1]!;
  const span = cumulative[index]! - start;
  const fraction = span === 0 ? 0 : (meters - start) / span;
  const a = path[index - 1]!;
  const b = path[index]!;
  return { lat: a.lat + (b.lat - a.lat) * fraction, lon: a.lon + (b.lon - a.lon) * fraction };
}

/** Compass bearing from `a` to `b`, in degrees clockwise from north; null when
 *  they are the same place. */
export function bearingDegrees(a: Point, b: Point): number | null {
  const dy = b.lat - a.lat;
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  if (dx === 0 && dy === 0) return null;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Which way the path runs at `alongMeters`: towards a point a little further on. */
export function bearingAlong(path: Point[], alongMeters: number, cumulative: number[] = cumulativeMeters(path)): number | null {
  if (path.length < 2) return null;
  const total = cumulative[cumulative.length - 1]!;
  const from = Math.min(alongMeters, Math.max(0, total - HEADING_LOOKAHEAD_METERS));
  return bearingDegrees(pointAlong(path, from, cumulative), pointAlong(path, from + HEADING_LOOKAHEAD_METERS, cumulative));
}

export type WalkGuidance = {
  /** The next move to make, and the street it leads onto. */
  maneuver: WalkManeuver;
  street: string | null;
  metersToManeuver: number;
  /** The rest of the walk, from where the rider is. */
  remainingMeters: number;
  /** The rider is further than `OFF_ROUTE_METERS` from the walk's line. */
  offRoute: boolean;
};

/**
 * What a walking rider needs next: the next turn and how far away it is.
 *
 * The rider is placed on the walk's line by their nearest point to it, and the
 * next turn is the first step starting further on than that -- skipping the
 * walk's own "depart", which is where they already are. With no turns left, or
 * none at all (a walk the server sent without them), what is next is arriving.
 * Without a position the rider is taken to be at the start.
 */
export function walkGuidance(path: Point[], steps: readonly WalkStep[], position: Point | null): WalkGuidance | null {
  if (path.length < 2) return null;
  const cumulative = cumulativeMeters(path);
  const total = cumulative[cumulative.length - 1]!;
  const projection = position === null ? null : projectOntoPath(position, path, cumulative);
  const along = projection?.alongMeters ?? 0;
  const offRoute = projection !== null && projection.offsetMeters > OFF_ROUTE_METERS;

  const upcoming = steps.find((step) => {
    if (step.maneuver === 'depart') return false;
    const at = cumulative[Math.max(0, Math.min(step.beginShapeIndex, cumulative.length - 1))]!;
    return at > along + AT_MANEUVER_METERS;
  });
  const remainingMeters = Math.max(0, total - along);

  if (!upcoming || upcoming.maneuver === 'arrive') {
    return { maneuver: 'arrive', street: null, metersToManeuver: remainingMeters, remainingMeters, offRoute };
  }
  const at = cumulative[Math.max(0, Math.min(upcoming.beginShapeIndex, cumulative.length - 1))]!;
  return {
    maneuver: upcoming.maneuver,
    street: upcoming.street,
    metersToManeuver: Math.max(0, at - along),
    remainingMeters,
    offRoute,
  };
}

/** The smaller angle between two compass headings, 0..180. */
export function angleBetween(a: number, b: number): number {
  const difference = Math.abs(((a - b) % 360) + 360) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/**
 * A distance to a turn as a walker reads it: to 10 m close up, to 50 m further
 * away, to 100 m beyond a kilometre. "In 237 m" is precision a phone's fix does
 * not have and a walker cannot use.
 */
export function guidanceMeters(meters: number): number {
  if (meters < 100) return Math.max(10, Math.round(meters / 10) * 10);
  if (meters < 1000) return Math.round(meters / 50) * 50;
  return Math.round(meters / 100) * 100;
}
