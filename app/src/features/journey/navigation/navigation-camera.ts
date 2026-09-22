import type { Itinerary } from '@/api/types';
import { legFocusCoordinates, withMinimumSpan, type LatLng } from '@/features/results/map-focus';
import { decodePolyline } from '@/lib/polyline';

import { legPath } from '../journey-progress';
import type { JourneyState, RiderPosition } from '../types';
import { bearingAlong, cumulativeMeters, projectOntoPath, type Point } from './walk-guidance';

/** The map looking ahead from a moving point, turned to the way it is going. */
export type FollowCamera = {
  kind: 'follow';
  center: LatLng;
  /** Degrees clockwise from north. */
  heading: number;
  pitch: number;
  /** Google Maps' zoom level. */
  zoom: number;
  /** Apple Maps' camera height, in metres -- its equivalent of `zoom`. */
  altitude: number;
};

/** The map framing a handful of points that all matter at once. */
export type FrameCamera = { kind: 'frame'; coordinates: LatLng[] };

export type NavigationCamera = FollowCamera | FrameCamera;

/**
 * A fix older than this says where the rider was, not where they are.
 *
 * Minutes, not seconds: every watch feeding this reports on movement, so a rider
 * standing still at a corner -- reading the map, waiting for a light -- sends no
 * new fix at all, and a tight limit threw the map out of following at exactly
 * that moment. A watch re-reports as soon as the app comes back to the front, so
 * a genuinely old fix does not linger past a resume.
 */
export const FIX_FRESH_SECONDS = 5 * 60;
/** A fix vaguer than this cannot be followed: the map would lurch between guesses. */
export const FIX_MAX_ACCURACY_METERS = 80;

/** On foot: close, and tilted to see the next corner coming. */
const WALK_CAMERA = { pitch: 55, zoom: 18, altitude: 350 };
/** On a vehicle: further out, so the next stops are on screen. */
const RIDE_CAMERA = { pitch: 35, zoom: 16, altitude: 1400 };

export type NavigationCameraInput = {
  itinerary: Itinerary;
  state: Pick<JourneyState, 'phase' | 'legIndex'>;
  fix: RiderPosition | null;
  now: Date;
  /** Which way the phone faces, from its compass; null when unknown. */
  compassHeading: number | null;
  /** The vehicle of the current ride, from the live feed. */
  bus: Point | null;
  /** The walk the rider was re-routed onto, when they left the planned one. */
  walkGeometry?: string | null;
};

function toLatLng(point: Point): LatLng {
  return { latitude: point.lat, longitude: point.lon };
}

/** A fix fit to steer the map by: recent, and precise enough. */
export function usableFix(fix: RiderPosition | null, now: Date): RiderPosition | null {
  if (!fix) return null;
  const ageSeconds = (now.getTime() - new Date(fix.at).getTime()) / 1000;
  return ageSeconds <= FIX_FRESH_SECONDS && fix.accuracyMeters <= FIX_MAX_ACCURACY_METERS ? fix : null;
}

function frameLeg(itinerary: Itinerary, legIndex: number, extra: Point[] = []): FrameCamera | null {
  const coordinates = [...legFocusCoordinates(itinerary, legIndex), ...extra.map(toLatLng)];
  return coordinates.length === 0 ? null : { kind: 'frame', coordinates: withMinimumSpan(coordinates) };
}

/**
 * Where the running journey's map should look, phase by phase -- what makes it
 * read as navigation rather than as a picture of the trip.
 *
 * - **Walking**: follows the rider close and tilted, turned to where the phone
 *   faces (or, without a compass, the way the walk runs from where they are).
 * - **Waiting**: frames the stop, the rider and the approaching vehicle
 *   together -- the three things that decide whether they make it.
 * - **Riding**: follows the ride further out, turned along its route, from the
 *   rider's own fix or -- when that is too weak -- the vehicle's position.
 *
 * Falls back to framing the leg whenever there is nothing fresh to follow, and
 * returns null where there is no single place to look (off plan, arrived), so
 * the map frames the journey as it always has.
 */
export function navigationCamera(input: NavigationCameraInput): NavigationCamera | null {
  const { itinerary, state, now, compassHeading, bus } = input;
  if (state.phase === 'off-plan' || state.phase === 'arrived') return null;
  const leg = itinerary.legs[state.legIndex];
  if (!leg) return null;
  const fix = usableFix(input.fix, now);

  if (leg.type === 'walk') {
    if (!fix) return frameLeg(itinerary, state.legIndex);
    const path = input.walkGeometry
      ? decodePolyline(input.walkGeometry).map(([lat, lon]) => ({ lat, lon }))
      : legPath(leg);
    const cumulative = cumulativeMeters(path);
    const along = projectOntoPath(fix, path, cumulative)?.alongMeters ?? 0;
    const heading = compassHeading ?? bearingAlong(path, along, cumulative) ?? 0;
    return { kind: 'follow', center: toLatLng(fix), heading, ...WALK_CAMERA };
  }

  if (state.phase === 'waiting' || state.phase === 'walking-to-stop' || state.phase === 'transferring') {
    return frameLeg(itinerary, state.legIndex, [leg.from.stop, ...(fix ? [fix] : []), ...(bus ? [bus] : [])]);
  }

  const anchor: Point | null = fix ?? bus;
  if (!anchor) return frameLeg(itinerary, state.legIndex);
  const path = legPath(leg);
  const cumulative = cumulativeMeters(path);
  const along = projectOntoPath(anchor, path, cumulative)?.alongMeters ?? 0;
  return { kind: 'follow', center: toLatLng(anchor), heading: bearingAlong(path, along, cumulative) ?? 0, ...RIDE_CAMERA };
}

/** Degrees the map's heading snaps to, so a compass jittering by a degree or
 *  two does not animate the map on every reading. */
const HEADING_STEP_DEGREES = 10;

/**
 * An identity for a camera that only changes when moving the map would be
 * visible: about a metre of position, `HEADING_STEP_DEGREES` of heading. The
 * map animates when this changes and at no other time.
 */
export function cameraKey(camera: NavigationCamera | null): string {
  if (!camera) return 'none';
  const round = (value: number) => value.toFixed(5);
  if (camera.kind === 'frame') {
    return `frame:${camera.coordinates.map((c) => `${round(c.latitude)},${round(c.longitude)}`).join(';')}`;
  }
  const heading = (Math.round(camera.heading / HEADING_STEP_DEGREES) * HEADING_STEP_DEGREES) % 360;
  return `follow:${round(camera.center.latitude)},${round(camera.center.longitude)}:${heading}:${camera.pitch}:${camera.zoom}`;
}
