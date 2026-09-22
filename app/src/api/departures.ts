import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { StopDeparturesResponse } from './types';

/** Countdowns go stale fast -- refetch often enough that "3 min" doesn't sit
 *  on screen well past when the bus has actually left. */
const DEPARTURES_STALE_TIME_MS = 15_000;
const DEPARTURES_REFETCH_INTERVAL_MS = 30_000;

/**
 * Passed explicitly rather than left to the endpoint's own default, because
 * an empty board is a real, common answer here (a Saturday in Israel has no
 * bus service at all) and the UI has to name the window it searched -- "no
 * buses in the next hour" is only honest if the caller picked that hour.
 */
export const DEPARTURES_WINDOW_MINUTES = 60;

export function useStopDepartures(stopId: string | null, limit: number, lang: string) {
  return useQuery({
    queryKey: ['stopDepartures', stopId, limit, lang],
    queryFn: () => apiGet<StopDeparturesResponse>(`/stops/${stopId}/departures`, {
      limit, lang, window: DEPARTURES_WINDOW_MINUTES,
    }),
    enabled: stopId !== null,
    staleTime: DEPARTURES_STALE_TIME_MS,
    refetchInterval: DEPARTURES_REFETCH_INTERVAL_MS,
  });
}
