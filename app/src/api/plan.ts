import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { PlanQuery, PlanResponse } from './types';

/**
 * How often an open results screen re-plans.
 *
 * The countdowns on the cards tick on their own (`useNow`), so this is not
 * about keeping "in 26 min" honest -- that already is. It is about the SET of
 * journeys: leave the screen open and the trips it offers depart one by one
 * until every card reads "already gone" and no newer departure ever appears.
 *
 * A minute rather than the departure boards' thirty seconds because `/plan`
 * is the expensive endpoint on this deployment -- a RAPTOR search per
 * request, on one small box -- and a journey list goes stale on the scale of
 * whole minutes, not seconds. React Query pauses this while the app is in
 * the background, and refetches on focus regardless, so the case it covers
 * is specifically a screen left open and watched.
 */
const PLAN_REFETCH_INTERVAL_MS = 60_000;
/** Long enough that navigating between results and the trip screen reuses
 *  the cached plan rather than re-running the search on every hop. */
const PLAN_STALE_TIME_MS = 30_000;

export function usePlanTrip(query: PlanQuery | null) {
  return useQuery({
    queryKey: ['plan', query],
    // `{ ...query }` (not `query` directly) because `PlanQuery` has no index
    // signature and isn't assignable to apiGet's `Record<string, ...>` params
    // type on its own — a fresh object literal is. Spreading `null` is valid
    // JS/TS and yields `{}`, which is fine since `enabled` prevents this from
    // ever running while `query` is null.
    queryFn: () => apiGet<PlanResponse>('/plan', { ...query }),
    enabled: query !== null,
    staleTime: PLAN_STALE_TIME_MS,
    refetchInterval: PLAN_REFETCH_INTERVAL_MS,
  });
}
