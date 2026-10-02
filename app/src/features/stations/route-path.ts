import type { RouteShapeResponse } from '@/api/types';
import { shapeCredit } from '@/lib/attribution';

export type RoutePath = {
  coordinates: { latitude: number; longitude: number }[];
  color: string;
  dashed: boolean;
  /** "osm" when the line is OpenStreetMap rail track, which must be credited
   *  on the map that draws it. */
  credit: 'osm' | null;
};

/** A route shape as the station map draws it, or null when there is no line
 *  to draw. */
export function routePath(shape: RouteShapeResponse, color: string): RoutePath | null {
  // GeoJSON puts longitude first; the map wants latitude, named.
  const coordinates = shape.geometry.coordinates.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
  if (coordinates.length < 2) return null;
  return { coordinates, color, dashed: shape.geometryFallback, credit: shapeCredit(shape.attribution) };
}
