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

/**
 * A stop's board, optionally cut to the runs that stop near `to` without
 * changing -- each of those rows then carrying when it gets there.
 *
 * The destination is a POINT rather than a stop id because a rider can name
 * a railway station or a landmark, and almost never the bus stop beside it.
 * How near counts as arriving is the SERVER's to decide, so that every
 * caller means the same thing by it.
 *
 * The filter is the server's to apply too, for a separate reason: the board
 * is capped at `limit` rows, and a stop where one bus an hour goes where the
 * rider is going would have that one row truncated away before any
 * client-side filter could see it.
 */
export function useStopDepartures(
  stopId: string | null, limit: number, lang: string,
  to?: { lat: number; lon: number } | null,
) {
  const destination = to ?? null;
  return useQuery({
    queryKey: ['stopDepartures', stopId, limit, lang, destination?.lat ?? null, destination?.lon ?? null],
    queryFn: () => apiGet<StopDeparturesResponse>(`/stops/${stopId}/departures`, {
      limit, lang, window: DEPARTURES_WINDOW_MINUTES,
      ...(destination === null ? {} : { toLat: destination.lat, toLon: destination.lon }),
    }),
    enabled: stopId !== null,
    staleTime: DEPARTURES_STALE_TIME_MS,
    refetchInterval: DEPARTURES_REFETCH_INTERVAL_MS,
  });
}
