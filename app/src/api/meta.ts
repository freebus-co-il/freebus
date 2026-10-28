import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { MetaResponse } from './types';

/** Server capabilities change only on deploy, so this is effectively static
 *  for a session -- but not `Infinity`, so a client left open across a
 *  deploy that finally turns realtime on picks it up. */
const META_STALE_TIME_MS = 5 * 60_000;

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: () => apiGet<MetaResponse>('/meta'),
    staleTime: META_STALE_TIME_MS,
  });
}

/**
 * Whether this deployment has live vehicle data at all.
 *
 * The gate for every live-vs-scheduled affordance in the app. We do not have
 * a SIRI key from the ministry yet, so today this is always false and the
 * app shows plain times with no annotation -- exactly as it did before any
 * of this existed. The moment a key is configured the server starts
 * reporting a non-`disabled` health here and the affordances appear on their
 * own, with no client release.
 *
 * `stale` and `failing` still count as available: the feed IS wired up, some
 * departures will carry predictions, and the ones that don't are correctly
 * shown as scheduled. Only `disabled` -- no credentials at all -- means the
 * distinction is meaningless and must stay hidden. Treats "still loading"
 * as unavailable so nothing flickers in and back out on a cold start.
 */
export function useRealtimeAvailable(): boolean {
  const { data } = useMeta();
  return data !== undefined && data.realtime.health !== 'disabled';
}
