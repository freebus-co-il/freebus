import { useQuery } from '@tanstack/react-query';

import { useAppActive } from '@/hooks/use-app-active';

import { apiGet } from './client';
import type { VehiclesResponse } from './types';

/**
 * How often the map asks where the buses are.
 *
 * The server polls the ministry every `REALTIME_POLL_SECONDS` (30 by
 * default) and answers from that in-memory snapshot, so asking faster than
 * that only re-reads the same generation. Twenty seconds keeps the dot at
 * most ~20s behind the newest snapshot the server holds without ever
 * skipping one, and the request itself is a handful of map lookups -- no
 * database, no upstream call, nothing that grows with the number of riders
 * watching.
 */
const VEHICLES_POLL_MS = 20_000;

/**
 * The live positions of the buses running `tripIds`.
 *
 * Polls only while the app is in the FOREGROUND: React Query's
 * `refetchInterval` has no idea an RN app has been backgrounded (see
 * `useAppActive`), and a map nobody is looking at should cost nothing.
 * Callers pass `enabled: false` to add their own condition on top -- a
 * screen that is mounted but not the one on top, say. The `foreground`
 * option overrides the app active state for cases where a caller knows the
 * screen is visible while AppState reports otherwise.
 *
 * `staleTime: 0` on purpose. A vehicle position is stale the instant it
 * arrives, and the whole value of this query is that the interval keeps
 * replacing it.
 */
export function useVehicles(tripIds: readonly string[], options: { enabled?: boolean; foreground?: boolean } = {}) {
  const appActive = useAppActive();
  // An override for a caller that knows the app is on screen when AppState
  // says otherwise: a journey's picture-in-picture window is visible while
  // React Native reports the activity as backgrounded.
  const foreground = options.foreground ?? appActive;
  // The query KEY, so switching journeys refetches rather than showing the
  // previous journey's buses. Sorted so two callers naming the same trips in
  // a different order share one cache entry and one poll.
  const trips = [...new Set(tripIds)].sort().join(',');

  return useQuery({
    queryKey: ['vehicles', trips],
    queryFn: () => apiGet<VehiclesResponse>('/vehicles', { trips }),
    enabled: (options.enabled ?? true) && foreground && trips !== '',
    refetchInterval: VEHICLES_POLL_MS,
    staleTime: 0,
  });
}

/**
 * Every bus currently on `routeId` -- one direction of a line -- for the line
 * page's map. The same poll, the same foreground-only rule and the same
 * response as `useVehicles`; only the question differs, because a line page
 * knows no trip ids for the buses already on the road.
 */
export function useRouteVehicles(routeId: string | null, options: { enabled?: boolean } = {}) {
  const appActive = useAppActive();

  return useQuery({
    queryKey: ['routeVehicles', routeId],
    queryFn: () => apiGet<VehiclesResponse>(`/routes/${encodeURIComponent(routeId!)}/vehicles`),
    enabled: (options.enabled ?? true) && appActive && routeId !== null,
    refetchInterval: VEHICLES_POLL_MS,
    staleTime: 0,
  });
}
