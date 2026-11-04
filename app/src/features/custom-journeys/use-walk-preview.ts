import { useQuery } from '@tanstack/react-query';

import { fetchWalk } from '@/api/walk';
import type { LatLng } from '@/features/results/map-focus';
import { decodePolyline } from '@/lib/polyline';

type Point = { lat: number; lon: number };

/** The walk to a nearby stop the rider asked to see, from where they stood
 *  when they asked. */
export type WalkPreview = { stopId: string; from: Point; to: Point };

/**
 * The street walk to a suggested stop, for the map to draw and frame while the
 * rider decides. One `/walk` request per stop they ask about, and none until
 * they ask: the suggestion itself already knows how long the walk is.
 *
 * Null until the walk is known. A walk the server could not route comes back
 * as the straight line between the two, which still says which way to go.
 */
export function useWalkPreview(preview: WalkPreview | null): LatLng[] | null {
  const { data } = useQuery({
    queryKey: ['nearbyWalkPreview', preview?.stopId ?? null, preview?.from.lat ?? null, preview?.from.lon ?? null],
    queryFn: () => fetchWalk(preview!.from, preview!.to),
    enabled: preview !== null,
    // From where the rider stood when they asked, so it does not go stale
    // while they look at it.
    staleTime: Infinity,
  });
  if (preview === null || !data) return null;
  if (data.geometry) {
    const path = decodePolyline(data.geometry).map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
    if (path.length >= 2) return path;
  }
  return [
    { latitude: preview.from.lat, longitude: preview.from.lon },
    { latitude: preview.to.lat, longitude: preview.to.lon },
  ];
}
