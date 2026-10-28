import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { TripDetail } from './types';

/** A trip's timetable is the schedule itself, not an instance of it -- it
 *  does not change under the rider while they read it. */
const TRIP_STALE_TIME_MS = 5 * 60_000;

/**
 * `keepPreviousData` is for a page that swaps its trip for another in place:
 * while the new trip loads, the query keeps answering with the last one
 * instead of `undefined`, so everything derived from it -- the route, its
 * shape, the map itself -- stays put rather than blanking out and remounting.
 * Off by default: everywhere else a different trip must not show the old one.
 */
export function useTrip(tripId: string | null, lang: string, options: { keepPreviousData?: boolean } = {}) {
  return useQuery({
    queryKey: ['trip', tripId, lang],
    queryFn: () => apiGet<TripDetail>(`/trips/${tripId}`, { lang }),
    enabled: tripId !== null,
    staleTime: TRIP_STALE_TIME_MS,
    placeholderData: options.keepPreviousData ? keepPreviousData : undefined,
  });
}
