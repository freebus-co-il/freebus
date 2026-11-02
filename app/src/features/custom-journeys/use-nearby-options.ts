import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGet } from '@/api/client';
import { DEPARTURES_WINDOW_MINUTES } from '@/api/departures';
import type { NearbyStopsResponse, StopDeparturesResponse, TransitLeg } from '@/api/types';
import type { StationBoard } from '@/features/journey/use-station-board';
import type { ActiveJourney, JourneyState, RiderPosition } from '@/features/journey/types';
import { useAppActive } from '@/hooks/use-app-active';

import { rankNearby, type NearbyOptions, type NearbyStopBoard } from './nearby-options';

/** Around a station: its exits and the stops across the road, not the next
 *  neighbourhood. */
const NEARBY_RADIUS_METERS = 450;
/** Stops asked about besides the planned one. Each is one board request per
 *  refresh, so this is the ceiling on what a waiting rider costs the box. */
const NEARBY_STOP_LIMIT = 6;
const NEARBY_BOARD_LIMIT = 15;
/** A little slower than the station board's own beat: these are the
 *  alternatives, not the run the rider is about to board. */
const NEARBY_REFETCH_MS = 45_000;
const NEARBY_STALE_MS = 20_000;

const LOOKING: ReadonlySet<JourneyState['phase']> = new Set(['walking-to-stop', 'transferring', 'waiting']);

const EMPTY: NearbyOptions = { options: [], strong: null, gainSeconds: null };

/**
 * The stops around the ride's station that also make the step, for a journey
 * the rider built: while they walk to the station, step out of it, or wait
 * there, in the foreground only. Off for every other journey, so it costs
 * nothing until a rider asks for it.
 */
export function useNearbyOptions(
  journey: ActiveJourney | null,
  state: JourneyState | null,
  board: StationBoard,
  position: RiderPosition | null,
  now: Date,
): NearbyOptions & { legIndex: number | null } {
  const { i18n } = useTranslation();
  const active = useAppActive();
  const legIndex = board.legIndex;
  const leg = legIndex === null ? null : (journey?.itinerary.legs[legIndex] as TransitLeg | undefined) ?? null;
  const target = board.target;
  const enabled = Boolean(journey?.custom)
    && active
    && state !== null
    && LOOKING.has(state.phase)
    && leg?.type === 'transit'
    && target !== null;
  const center = enabled && leg ? { lat: leg.from.stop.lat, lon: leg.from.stop.lon } : null;

  const { data: nearby } = useQuery({
    queryKey: ['journeyNearbyStops', center?.lat ?? null, center?.lon ?? null, i18n.language],
    queryFn: () => apiGet<NearbyStopsResponse>('/stops/nearby', {
      lat: center!.lat,
      lon: center!.lon,
      radius: NEARBY_RADIUS_METERS,
      limit: NEARBY_STOP_LIMIT + 1,
      lang: i18n.language,
    }),
    enabled: center !== null,
    // Where the stops stand changes with the feed, once a day.
    staleTime: 10 * 60_000,
  });

  const stops = useMemo(
    () => (enabled && nearby
      ? nearby.stops.filter((stop) => stop.stopId !== leg?.from.stop.stopId).slice(0, NEARBY_STOP_LIMIT)
      : []),
    [enabled, nearby, leg],
  );

  const boards = useQueries({
    queries: stops.map((stop) => ({
      queryKey: ['journeyNearbyBoard', stop.stopId, target?.lat ?? null, target?.lon ?? null, i18n.language],
      queryFn: () => apiGet<StopDeparturesResponse>(`/stops/${stop.stopId}/departures`, {
        limit: NEARBY_BOARD_LIMIT,
        lang: i18n.language,
        window: DEPARTURES_WINDOW_MINUTES,
        toLat: target!.lat,
        toLon: target!.lon,
      }),
      enabled,
      staleTime: NEARBY_STALE_MS,
      refetchInterval: enabled ? NEARBY_REFETCH_MS : (false as const),
    })),
  });

  // One string that changes whenever any board answers again: the array of
  // results is new every render, so it cannot be a dependency itself.
  const boardsKey = boards.map((each) => each.dataUpdatedAt).join(',');
  const boardData = boards.map((each) => each.data);
  const nowMs = now.getTime();
  const ranked = useMemo<NearbyOptions>(() => {
    if (!enabled || !leg || !target) return EMPTY;
    const withBoards: NearbyStopBoard[] = stops.flatMap((stop, index) => {
      const data = boardData[index];
      return data ? [{ stopId: stop.stopId, name: stop.name, lat: stop.lat, lon: stop.lon, departures: data.departures }] : [];
    });
    const from = position ?? { lat: leg.from.stop.lat, lon: leg.from.stop.lon };
    return rankNearby({ leg, target, currentRuns: board.runs, boards: withBoards, from, nowMs });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `boardsKey` stands for `boardData`
  }, [enabled, leg, target, stops, board.runs, position, nowMs, boardsKey]);

  return { ...ranked, legIndex: enabled ? legIndex : null };
}
