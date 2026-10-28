import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { AgenciesResponse } from './types';

/** The operator list changes only when a feed is loaded, so it is
 *  effectively static for a session -- same reasoning as `useMeta`. */
const AGENCIES_STALE_TIME_MS = 5 * 60_000;

export function useAgencies() {
  return useQuery({
    queryKey: ['agencies'],
    queryFn: () => apiGet<AgenciesResponse>('/agencies'),
    staleTime: AGENCIES_STALE_TIME_MS,
  });
}
