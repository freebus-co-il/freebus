import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '@/api/client';
import type { Itinerary, PlanResponse, TransitLeg } from '@/api/types';
import { useAppActive } from '@/hooks/use-app-active';
import { hapticRerouted } from '@/lib/haptics';

import type { ActiveJourney, JourneyState, LiveJourneyInput, RiderPosition } from '../types';
import { decideSwitch } from './decide';
import { replanOriginFor, spliceItinerary } from './splice';
import { replanReason, type ReplanMemory } from './triggers';

/** How many ways to ask for: enough to have some left after filtering by the
 *  backbone, few enough to keep the search cheap. */
const REPLAN_RESULTS = 6;

export type ReplanSwitch = {
  at: number;
  gainSeconds: number;
  /** The first line of the new way, for "Switched to 189". */
  line: string | null;
  /** The rider has to stand somewhere else now: named, so the toast can say so. */
  changedStopName: string | null;
};

export type LiveReplan = {
  status: 'idle' | 'recalculating';
  lastSwitch: ReplanSwitch | null;
  /** A way outside the trip the rider chose, offered only after theirs broke. */
  offer: Itinerary | null;
  acceptOffer: () => void;
  dismissOffer: () => void;
  /** The ways the last re-plan found, for the stop view's "or 189 in 6 min". */
  candidates: Itinerary[];
};

const EMPTY_MEMORY: ReplanMemory = { lastRunAt: null, lastSwitchAt: null, inFlight: false, arrivalAtLastPlan: null };

function firstRide(itinerary: Itinerary, fromLegIndex = 0): TransitLeg | null {
  return itinerary.legs.slice(fromLegIndex).find((leg): leg is TransitLeg => leg.type === 'transit') ?? null;
}

/** Walking the candidate's opening walk is what stands between the rider and
 *  its first bus -- that, and a ride they are still sitting on. */
function readyAt(nowMs: number, departAfter: string | undefined) {
  return (candidate: Itinerary): number => {
    const start = Math.max(nowMs, departAfter ? Date.parse(departAfter) : nowMs);
    let walkSeconds = 0;
    for (const leg of candidate.legs) {
      if (leg.type === 'transit') break;
      walkSeconds += leg.durationSeconds;
    }
    return start + walkSeconds * 1000;
  };
}

/**
 * Keeps an active journey going on its own: asks the planner again when
 * something happens (see `replanReason`), and switches to a sooner way inside
 * the rider's backbone without asking (see `decideSwitch`). Foreground only,
 * one request at a time, throttled -- `/plan` is the expensive endpoint.
 */
export function useLiveReplan(args: {
  journey: ActiveJourney | null;
  state: JourneyState | null;
  live: LiveJourneyInput | null;
  position: RiderPosition | null;
  /** The journey's destination as a `/plan` place, or null if it has none. */
  destination: string | null;
  lang: string;
  replaceItinerary: (itinerary: Itinerary, keepThroughLegIndex: number) => Promise<void>;
}): LiveReplan {
  const { journey, state, live, position, destination, lang, replaceItinerary } = args;
  const active = useAppActive();
  const memory = useRef<ReplanMemory>(EMPTY_MEMORY);
  const memoryFor = useRef<string | null>(null);
  const [status, setStatus] = useState<LiveReplan['status']>('idle');
  const [lastSwitch, setLastSwitch] = useState<ReplanSwitch | null>(null);
  const [offer, setOffer] = useState<{ itinerary: Itinerary; keep: number; journeyId: string } | null>(null);
  const [candidates, setCandidates] = useState<Itinerary[]>([]);
  // An offer the rider turned down stays turned down: the same way coming
  // back every 45 seconds would be nagging, not help.
  const dismissedTripId = useRef<string | null>(null);

  // The latest journey and swap function, for a request that answers after
  // the render that sent it.
  const latest = useRef({ journey, replaceItinerary });
  useEffect(() => {
    latest.current = { journey, replaceItinerary };
  }, [journey, replaceItinerary]);

  useEffect(() => {
    if (!journey || !state || !active || destination === null) return;
    if (memoryFor.current !== journey.id) {
      memoryFor.current = journey.id;
      memory.current = { ...EMPTY_MEMORY, arrivalAtLastPlan: state.arrivalTime };
    }
    const nowMs = Date.now();
    const reason = replanReason({ state, live, memory: memory.current, nowMs });
    if (reason === null) return;
    const origin = replanOriginFor(state, journey.itinerary, position, nowMs);
    if (origin === null) return;

    const broken = reason === 'off-plan' || reason === 'connection-broken';
    const journeyId = journey.id;
    const before = journey.itinerary;
    memory.current = { ...memory.current, inFlight: true, lastRunAt: nowMs };
    if (broken) setStatus('recalculating');

    void apiGet<PlanResponse>('/plan', {
      from: origin.from,
      to: destination,
      departAfter: origin.departAfter,
      lang,
      results: REPLAN_RESULTS,
    })
      .then(async (response) => {
        if (latest.current.journey?.id !== journeyId) return;
        setCandidates(response.itineraries);
        const decision = decideSwitch({
          currentArrival: state.arrivalTime,
          broken,
          backbone: journey.backbone ?? null,
          candidates: response.itineraries,
          nowMs,
          lastSwitchAt: memory.current.lastSwitchAt,
          readyAtMs: readyAt(nowMs, origin.departAfter),
        });
        if (decision.kind === 'switch') {
          const spliced = spliceItinerary(before, origin.keepThroughLegIndex, decision.itinerary);
          await latest.current.replaceItinerary(spliced, origin.keepThroughLegIndex);
          hapticRerouted();
          const oldStop = firstRide(before, origin.keepThroughLegIndex + 1)?.from.stop;
          const newStop = firstRide(decision.itinerary)?.from.stop;
          setLastSwitch({
            at: Date.now(),
            gainSeconds: decision.gainSeconds,
            line: firstRide(decision.itinerary)?.route.shortName ?? null,
            changedStopName: oldStop?.stopId && newStop?.stopId && oldStop.stopId !== newStop.stopId ? newStop.name ?? null : null,
          });
          setOffer(null);
          memory.current = { ...memory.current, lastSwitchAt: Date.now(), arrivalAtLastPlan: spliced.arrivalTime };
          return;
        }
        if (decision.kind === 'offer' && firstRide(decision.itinerary)?.tripId !== dismissedTripId.current) {
          setOffer({ itinerary: decision.itinerary, keep: origin.keepThroughLegIndex, journeyId });
        }
        memory.current = { ...memory.current, arrivalAtLastPlan: state.arrivalTime };
      })
      .catch(() => {
        // A failed re-plan leaves the journey exactly as it was; the next
        // trigger, or the steady beat, asks again.
      })
      .finally(() => {
        memory.current = { ...memory.current, inFlight: false };
        setStatus('idle');
      });
  }, [journey, state, live, position, destination, lang, active]);

  const acceptOffer = useCallback(() => {
    const current = latest.current.journey;
    if (!offer || !current || current.id !== offer.journeyId) return;
    const spliced = spliceItinerary(current.itinerary, offer.keep, offer.itinerary);
    setOffer(null);
    void latest.current.replaceItinerary(spliced, offer.keep);
  }, [offer]);
  const dismissOffer = useCallback(() => {
    dismissedTripId.current = offer ? firstRide(offer.itinerary)?.tripId ?? null : null;
    setOffer(null);
  }, [offer]);

  return { status, lastSwitch, offer: offer?.itinerary ?? null, acceptOffer, dismissOffer, candidates };
}
