import type { Itinerary, Leg, Place } from '@/api/types';
import { decodePolyline } from '@/lib/polyline';

export type LatLng = { latitude: number; longitude: number };

/** Below this, a focused leg is framed as this much street instead: a 30 m
 *  walk fitted edge to edge zooms past anything the rider can place. */
export const MIN_FOCUS_SPAN_METERS = 300;

const METERS_PER_DEGREE_LAT = 111_320;

function legPlace(leg: Leg, end: 'from' | 'to'): Place {
  return leg.type === 'walk' ? leg[end] : leg[end].stop;
}

function toLatLng(place: Place): LatLng {
  return { latitude: place.lat, longitude: place.lon };
}

/** Every point one leg needs on screen: its ends, its drawn path, and -- for a
 *  ride -- the stops it passes, which sit off a straight-line fallback. */
export function legFocusCoordinates(itinerary: Itinerary, legIndex: number): LatLng[] {
  const leg = itinerary.legs[legIndex];
  if (!leg) return [];
  const path = leg.geometry
    ? decodePolyline(leg.geometry).map(([lat, lon]) => ({ latitude: lat, longitude: lon }))
    : [];
  const stops = leg.type === 'transit' ? leg.intermediateStops.map(toLatLng) : [];
  return [toLatLng(legPlace(leg, 'from')), ...path, ...stops, toLatLng(legPlace(leg, 'to'))];
}

/**
 * Pads a set of points out to at least `minMeters` on both axes, around its
 * own centre, by adding two corner points. Points already that wide come back
 * untouched, so a long ride is framed exactly as before.
 */
export function withMinimumSpan(points: LatLng[], minMeters = MIN_FOCUS_SPAN_METERS): LatLng[] {
  if (points.length === 0) return points;
  const lats = points.map((point) => point.latitude);
  const lons = points.map((point) => point.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;

  const halfLat = minMeters / METERS_PER_DEGREE_LAT / 2;
  const halfLon = halfLat / Math.max(Math.cos((centerLat * Math.PI) / 180), 0.01);
  const needsLat = maxLat - minLat < halfLat * 2;
  const needsLon = maxLon - minLon < halfLon * 2;
  if (!needsLat && !needsLon) return points;

  const south = needsLat ? Math.min(minLat, centerLat - halfLat) : minLat;
  const north = needsLat ? Math.max(maxLat, centerLat + halfLat) : maxLat;
  const west = needsLon ? Math.min(minLon, centerLon - halfLon) : minLon;
  const east = needsLon ? Math.max(maxLon, centerLon + halfLon) : maxLon;
  return [...points, { latitude: south, longitude: west }, { latitude: north, longitude: east }];
}
