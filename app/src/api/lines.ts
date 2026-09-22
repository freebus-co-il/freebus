import { useInfiniteQuery, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiGet } from './client';
import type { LineDetail, RouteRunsResponse, RouteShapeResponse, RoutesResponse } from './types';

/** A line's shape and stop sequence are the schedule itself, not state --
 *  the same reasoning, and the same figure, as `useTrip`. */
const LINE_STALE_TIME_MS = 5 * 60_000;

/** Runs carry live times, so they go stale on the same clock a departure
 *  board does. */
const RUNS_STALE_TIME_MS = 30_000;

/** One page of the browse/search list. Large enough that a line's rows are
 *  very unlikely to be the only thing straddling the boundary, small enough
 *  to render fast on a cold scroll. */
export const ROUTES_PAGE_SIZE = 50;

/** A repeatable query param, or nothing at all when there is no selection. */
function list(values: (string | number)[]): string | undefined {
  return values.length === 0 ? undefined : values.join(',');
}

/**
 * The Lines tab's list. Infinite rather than paged because the screen groups
 * route rows into lines over the ACCUMULATED result -- see `groupRoutes`,
 * which only converges when it can see every page loaded so far at once.
 */
export function useRouteSearch(
  q: string,
  filters: { agencies: string[]; types: number[]; excludeTypes?: number[] },
) {
  const trimmed = q.trim();
  // Comma-joined, and the param dropped entirely when the list is empty: an
  // empty selection means "no constraint", and `agency=` would read to the
  // backend as a constraint nothing can satisfy.
  const agency = list(filters.agencies);
  const type = list(filters.types);
  const excludeTypes = list(filters.excludeTypes ?? []);
  return useInfiniteQuery({
    queryKey: ['routeSearch', trimmed, agency, type, excludeTypes],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => apiGet<RoutesResponse>('/routes', {
      q: trimmed === '' ? undefined : trimmed,
      agency,
      type,
      excludeTypes,
      limit: ROUTES_PAGE_SIZE,
      offset: pageParam,
    }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.routes.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    staleTime: LINE_STALE_TIME_MS,
  });
}

export function useLine(lineCode: string | null, lang: string) {
  return useQuery({
    queryKey: ['line', lineCode, lang],
    queryFn: () => apiGet<LineDetail>(`/lines/${encodeURIComponent(lineCode!)}`, { lang }),
    enabled: lineCode !== null,
    staleTime: LINE_STALE_TIME_MS,
  });
}

/**
 * A route's next runs from its first stop -- or, given `around`, one run and
 * its neighbours timed at the rider's own stop (the line page opened from a
 * station board; see the API's `runsAround`).
 */
export function useRouteRuns(
  routeId: string | null, lang: string, around: { stopId: string; tripId: string } | null = null,
) {
  return useQuery({
    queryKey: ['routeRuns', routeId, lang, around?.stopId ?? null, around?.tripId ?? null],
    queryFn: () => apiGet<RouteRunsResponse>(`/routes/${encodeURIComponent(routeId!)}/trips`, {
      lang,
      stopId: around?.stopId,
      around: around?.tripId,
    }),
    enabled: routeId !== null,
    staleTime: RUNS_STALE_TIME_MS,
  });
}

function shapeData(results: UseQueryResult<RouteShapeResponse>[]): (RouteShapeResponse | undefined)[] {
  return results.map((result) => result.data);
}

/**
 * `useRouteShape` for several routes at once -- a journey's transit legs, whose
 * count varies, so one hook call per leg is not an option. The same cache key,
 * so the line page a rider opens next reads the entry this already fetched.
 * One entry per route, in order: `undefined` until that shape loads, and for
 * good if it fails -- a missing backdrop is not worth an error state.
 */
export function useRouteShapes(routes: readonly { routeId: string; directionId: number }[]) {
  return useQueries({
    queries: routes.map(({ routeId, directionId }) => ({
      queryKey: ['routeShape', routeId, directionId],
      queryFn: () => apiGet<RouteShapeResponse>(
        `/routes/${encodeURIComponent(routeId)}/shape`, { direction: directionId },
      ),
      staleTime: LINE_STALE_TIME_MS,
    })),
    // A stable function, so the combined array keeps its identity until a
    // shape actually arrives.
    combine: shapeData,
  });
}

export function useRouteShape(routeId: string | null, directionId: number) {
  return useQuery({
    queryKey: ['routeShape', routeId, directionId],
    queryFn: () => apiGet<RouteShapeResponse>(
      `/routes/${encodeURIComponent(routeId!)}/shape`, { direction: directionId },
    ),
    enabled: routeId !== null,
    staleTime: LINE_STALE_TIME_MS,
  });
}
