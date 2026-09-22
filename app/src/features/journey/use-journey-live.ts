import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, apiGet } from '@/api/client';
import { journeyCheckPath, type JourneyCheckResponse } from '@/api/journey-check';
import { useRealtimeAvailable } from '@/api/meta';
import { useTrip } from '@/api/trips';
import { useVehicles } from '@/api/vehicles';

import { liveBusFrom, liveFromCheck } from './live-input';
import { liveRequestPlan } from './live-request-plan';
import type { ActiveJourney, JourneyState, LiveJourneyInput } from './types';

/** The server refreshes its realtime snapshot about this often; asking faster
 *  only re-reads the same generation. */
const JOURNEY_CHECK_POLL_MS = 30_000;

function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500;
}

/** A response stamped with when it was fetched. Stamped inside the query
 *  rather than read off `dataUpdatedAt`, because a response carried over to a
 *  new chain as placeholder data reports the NEW query's update time -- zero --
 *  and the hold rule has to count from the fetch that actually happened. */
type StampedCheck = { response: JourneyCheckResponse; fetchedAt: string };

/**
 * Realtime for the journey, polled only while the rider can see it.
 *
 * `base` is the state resolved WITHOUT live input: it decides which legs are
 * still ahead and which bus is in play, and has to, because the live state
 * depends on this hook's answer. What to ask is `liveRequestPlan`'s decision;
 * this hook only adds the gates -- visible, realtime available, not rejected.
 *
 * Nothing here polls while the journey is out of sight. The queries keep
 * their last data, and the machine's hold rule decides how long that still
 * counts -- so the server's cost stays flat and the battery is spent only
 * while the rider is looking.
 */
export function useJourneyLive(
  journey: ActiveJourney | null,
  base: JourneyState | null,
  visible: boolean,
  now: Date,
): LiveJourneyInput | null {
  const { i18n } = useTranslation();
  const realtimeAvailable = useRealtimeAvailable();
  const lang = i18n.language;

  const plan = useMemo(() => liveRequestPlan(journey, base), [journey, base]);
  // Re-memoised on the key so a new `base` every tick does not hand the query
  // and the mapping below a new array every tick.
  const { checkKey } = plan;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const checked = useMemo(() => plan.checked, [checkKey]);

  // A chain the server rejected (a trip no longer running, a stop it does not
  // know) will not start answering on the next poll; stop asking about it.
  const [rejectedKey, setRejectedKey] = useState<string | null>(null);

  const check = useQuery({
    queryKey: ['journeyCheck', checkKey, lang],
    queryFn: async (): Promise<StampedCheck> => ({
      response: await apiGet<JourneyCheckResponse>(journeyCheckPath(checked, lang)),
      fetchedAt: new Date().toISOString(),
    }),
    enabled: visible && realtimeAvailable && checked.length > 0 && rejectedKey !== checkKey,
    refetchInterval: JOURNEY_CHECK_POLL_MS,
    staleTime: 0,
    // Completing a leg changes the chain, and so the key. Without this the
    // last prediction would vanish until the new chain's first answer landed:
    // the countdown would flip live -> scheduled -> live (two needless pushes)
    // and a flaky network would lose the prediction at once instead of
    // holding it. `liveFromCheck` drops whatever no longer lines up.
    placeholderData: keepPreviousData,
    retry: (failures, error) => !isClientError(error) && failures < 2,
  });

  // A chain the server rejected does not deserve a second effect-driven
  // render just to notice it: set during render, React's own pattern for
  // state that mirrors something the render just observed. Guarded so it
  // fires once per rejection rather than looping -- the next render sees
  // `rejectedKey === checkKey` and the condition is false again.
  if (isClientError(check.error) && rejectedKey !== checkKey) {
    setRejectedKey(checkKey);
  }

  const { ride, rideIndex } = plan;
  const wantsBus = visible && realtimeAvailable && plan.wantsBus;

  const vehicles = useVehicles(ride ? [ride.tripId] : [], { enabled: wantsBus, foreground: visible });
  const trip = useTrip(wantsBus && ride ? ride.tripId : null, lang);

  return useMemo(() => {
    if (!journey) return null;
    const fromCheck = check.data
      ? liveFromCheck(check.data.response, checked, check.data.fetchedAt)
      : { legs: [], connections: [] };
    const vehicle = ride ? vehicles.data?.vehicles.find((v) => v.tripId === ride.tripId) ?? null : null;
    const bus = ride && rideIndex >= 0 ? liveBusFrom(rideIndex, ride, trip.data, vehicle, now) : null;
    return { ...fromCheck, bus };
  }, [journey, check.data, checked, ride, rideIndex, vehicles.data, trip.data, now]);
}
