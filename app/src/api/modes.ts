import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { ModesResponse } from './types';

/** The feed's vehicle types. Effectively static -- the GTFS feed turns over
 *  once a day at most -- so this is cached for an hour rather than refetched
 *  alongside every plan. */
export function useTransitModes() {
  return useQuery({
    queryKey: ['modes'],
    queryFn: () => apiGet<ModesResponse>('/modes'),
    staleTime: 60 * 60 * 1000,
  });
}
