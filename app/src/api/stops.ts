import { useInfiniteQuery, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiGet } from './client';
import type { MapStop, NearbyStopsResponse, StopDetail, StopSearchResponse, StopsInBoxResponse } from './types';

export function useStopSearch(q: string, lang: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['stopSearch', trimmed, lang],
    queryFn: () => apiGet<StopSearchResponse>('/stops/search', { q: trimmed, lang, limit: 8 }),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  });
}

const NEARBY_STOPS_LIMIT = 5;
const NEARBY_STOPS_RADIUS_METERS = 1000;

export function useNearbyStops(coords: { lat: number; lon: number } | null, lang: string) {
  return useQuery({
    queryKey: ['nearbyStops', coords, lang],
    queryFn: () => apiGet<NearbyStopsResponse>('/stops/nearby', {
      lat: coords!.lat, lon: coords!.lon, radius: NEARBY_STOPS_RADIUS_METERS, limit: NEARBY_STOPS_LIMIT, lang,
    }),
    enabled: coords !== null,
    staleTime: 30_000,
  });
}

/** See `ROUTES_PAGE_SIZE` -- the same trade-off, and the cap `/stops/search`
 *  enforces. */
export const STOPS_PAGE_SIZE = 50;

/**
 * The Stations tab's list: search when there is a query, and an alphabetical
 * browse when there is not. One hook rather than two because the screen
 * renders the two identically and switching hooks on keystroke would
 * unmount the list.
 */
export function useStopBrowse(q: string, lang: string) {
  const trimmed = q.trim();
  return useInfiniteQuery({
    queryKey: ['stopBrowse', trimmed, lang],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => apiGet<StopSearchResponse>('/stops/search', {
      q: trimmed === '' ? undefined : trimmed,
      lang,
      limit: STOPS_PAGE_SIZE,
      offset: pageParam,
    }),
    // `/stops/search` reports no total, so "a short page is the last page"
    // is the only signal available.
    getNextPageParam: (last, pages) =>
      last.stops.length < STOPS_PAGE_SIZE ? undefined : pages.length * STOPS_PAGE_SIZE,
    staleTime: 30_000,
  });
}

/** A stop's own record -- its position and lines. The schedule, not state, so
 *  it is cached as long as a line's shape is. */
export function useStop(stopId: string | null, lang: string) {
  return useQuery({
    queryKey: ['stop', stopId, lang],
    queryFn: () => apiGet<StopDetail>(`/stops/${encodeURIComponent(stopId!)}`, { lang }),
    enabled: stopId !== null,
    staleTime: 5 * 60_000,
  });
}

type TileBox = { minLat: number; maxLat: number; minLon: number; maxLon: number };

/**
 * The stops on a map, one fixed tile at a time (see `tilesForRegion`): a pan
 * re-asks only for the tiles it newly reveals. Never stale within a session --
 * where the stops stand is the feed, which changes once a day.
 *
 * Tiles share their edges, so a stop exactly on one can arrive twice; the
 * caller dedupes by id.
 */
export function useStopsInTiles(tiles: readonly { key: string; box: TileBox }[], lang: string): MapStop[] {
  return useQueries({
    queries: tiles.map((tile) => ({
      queryKey: ['stopsInBox', tile.key, lang],
      queryFn: () => apiGet<StopsInBoxResponse>('/stops/in-box', { ...tile.box, lang }),
      staleTime: Infinity,
      gcTime: 30 * 60_000,
    })),
    combine: combineTileStops,
  });
}

/** Module-level, so `useQueries` can keep the combined array while no tile
 *  has changed. */
function combineTileStops(results: UseQueryResult<StopsInBoxResponse>[]): MapStop[] {
  return results.flatMap((result) => result.data?.stops ?? []);
}
