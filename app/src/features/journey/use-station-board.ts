import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGet } from '@/api/client';
import { DEPARTURES_WINDOW_MINUTES } from '@/api/departures';
import type { StopDeparturesResponse, TransitLeg } from '@/api/types';
import { useAppActive } from '@/hooks/use-app-active';

import { boardTarget, rememberRuns, stationRuns, type BoardTarget, type StationRun } from './station-board';
import type { ActiveJourney, JourneyState } from './types';

/** Enough rows to still have runs left once the board is cut to the step. The
 *  server filters by destination before it truncates, so this is a cap on
 *  runs that already make the step. */
const BOARD_LIMIT = 30;
const BOARD_STALE_MS = 15_000;
const BOARD_REFETCH_MS = 30_000;
/** How long a run the board showed is remembered after it was due: long
 *  enough to name a late train the rider boarded after it dropped off. */
const SEEN_FOR_MS = 30 * 60_000;

export type StationBoard = {
  /** The ride this board is for, or null when no ride is ahead. */
  legIndex: number | null;
  target: BoardTarget | null;
  /** The runs that make the step, soonest first. */
  runs: StationRun[];
  /** Every run the board has shown for this ride, for naming the one the
   *  rider got on. */
  seen: StationRun[];
  loading: boolean;
};

const PRE_BOARDING: ReadonlySet<JourneyState['phase']> = new Set(['walking-to-stop', 'transferring', 'waiting']);
const ON_BOARD: ReadonlySet<JourneyState['phase']> = new Set(['riding', 'alight-soon']);

/** The ride whose station board matters now: the one waited for or ridden, or
 *  the next one while walking to it. */
function boardLegIndex(journey: ActiveJourney | null, state: JourneyState | null): number | null {
  if (!journey || !state) return null;
  if (state.phase === 'waiting' || ON_BOARD.has(state.phase)) return state.leg ? state.legIndex : null;
  if (!PRE_BOARDING.has(state.phase)) return null;
  const next = journey.itinerary.legs.findIndex((leg, index) => index > state.legIndex && leg.type === 'transit');
  return next >= 0 ? next : null;
}

/**
 * The station board for the ride ahead: every run from its station that makes
 * the step, live. Fetched while the rider is on the way to the station or at
 * it, in the foreground only; on board it is not fetched again, but the runs
 * it showed are kept, which is what names the run the rider is on.
 */
export function useStationBoard(journey: ActiveJourney | null, state: JourneyState | null, now: Date): StationBoard {
  const { i18n } = useTranslation();
  const active = useAppActive();
  const legIndex = boardLegIndex(journey, state);
  const leg = legIndex === null ? null : (journey?.itinerary.legs[legIndex] as TransitLeg | undefined) ?? null;
  const target = useMemo(
    () => (journey && legIndex !== null ? boardTarget(journey.itinerary, legIndex) : null),
    [journey, legIndex],
  );
  const stopId = leg?.from.stop.stopId ?? null;
  const fetching = state !== null && PRE_BOARDING.has(state.phase) && active && target !== null && stopId !== null;

  const { data, isLoading } = useQuery({
    queryKey: ['journeyBoard', stopId, target?.lat ?? null, target?.lon ?? null, i18n.language],
    queryFn: () => apiGet<StopDeparturesResponse>(`/stops/${stopId}/departures`, {
      limit: BOARD_LIMIT,
      lang: i18n.language,
      window: DEPARTURES_WINDOW_MINUTES,
      // A rail station's platforms are separate stops; the rider can take a
      // train from any of them.
      includeSiblings: target?.mode === 'rail',
      toLat: target!.lat,
      toLon: target!.lon,
    }),
    enabled: fetching,
    staleTime: BOARD_STALE_MS,
    refetchInterval: fetching ? BOARD_REFETCH_MS : false,
  });

  const nowMs = now.getTime();
  const runs = useMemo(
    () => (data && leg && target ? stationRuns(data.departures, leg, target, nowMs) : []),
    [data, leg, target, nowMs],
  );

  // Remembered per ride, across refetches and after boarding. Adjusted during
  // render when the board or the ride changes, React's own pattern for state
  // derived from a changing input.
  const seenKey = journey && legIndex !== null ? `${journey.id}:${legIndex}:${stopId}` : null;
  const [remembered, setRemembered] = useState<{ key: string | null; from: StationRun[] | null; seen: StationRun[] }>(
    { key: null, from: null, seen: [] },
  );
  if (remembered.key !== seenKey || remembered.from !== runs) {
    setRemembered({
      key: seenKey,
      from: runs,
      seen: rememberRuns(remembered.key === seenKey ? remembered.seen : [], runs, nowMs - SEEN_FOR_MS),
    });
  }
  const seen = remembered.key === seenKey ? remembered.seen : runs;

  return { legIndex, target, runs, seen, loading: fetching && isLoading };
}
