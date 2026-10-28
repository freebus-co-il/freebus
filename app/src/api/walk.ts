import { apiGet } from './client';
import type { WalkRouteResponse } from './types';

type Point = { lat: number; lon: number };

/** `GET /walk`: the rest of a walk, from where the rider actually is. */
export function fetchWalk(from: Point, to: Point): Promise<WalkRouteResponse> {
  return apiGet<WalkRouteResponse>('/walk', {
    from: `${from.lat.toFixed(6)},${from.lon.toFixed(6)}`,
    to: `${to.lat.toFixed(6)},${to.lon.toFixed(6)}`,
  });
}
