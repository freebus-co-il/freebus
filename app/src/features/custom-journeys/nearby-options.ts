import type { Departure, Itinerary, Place, TransitLeg, WalkLeg } from '@/api/types';
import { stationRuns, withRun, type BoardTarget, type StationRun } from '@/features/journey/station-board';
import { haversineMeters } from '@/lib/geo';

/**
 * Out of the station, every stop around it is a way on: the one the plan
 * picked, the one across the road, the one by the other exit. Each gets the
 * same question the station board asks (which runs make the next step), and
 * the one that gets the rider there soonest, by enough to be worth the walk,
 * is the strong suggestion the map lights up.
 */

const WALK_METERS_PER_SECOND = 1.2;
const WALK_DETOUR = 1.3;
/** How much sooner another stop has to get the rider there before the map
 *  calls it out: less than this is not worth crossing the road for. */
export const STRONG_GAIN_SECONDS = 3 * 60;
/** A run that leaves sooner than the rider can walk to its stop, plus this
 *  margin to find the right side of the road, is not one they can catch. */
const CATCH_MARGIN_SECONDS = 30;

export type NearbyStopBoard = {
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
  /** Which sign the map hangs on its pin (see `stationKindOf`). */
  stationKind?: string;
  rail?: boolean;
  departures: readonly Departure[];
};

export type NearbyOption = {
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
  stationKind?: string;
  rail?: boolean;
  /** The planned boarding stop, whose own board the journey already follows. */
  current: boolean;
  walkSeconds: number;
  /** The soonest-arriving run the rider can still walk to and catch. */
  best: StationRun | null;
  /** When the best run gets the rider to the step's end, walk included. */
  reachesMs: number | null;
  /** Every catchable run, soonest first. */
  runs: StationRun[];
};

export type NearbyOptions = {
  options: NearbyOption[];
  /** The stop worth walking to instead, when there is one. */
  strong: NearbyOption | null;
  /** How much sooner the strong suggestion gets the rider there; null when
   *  the current stop has nothing catchable at all. */
  gainSeconds: number | null;
};

export function walkSecondsBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.round((haversineMeters(a, b) * WALK_DETOUR) / WALK_METERS_PER_SECOND);
}

/** When this run leaves the rider at the step's end: its arrival, plus the
 *  walk from where it sets them down on the last ride. */
export function reachesMs(run: StationRun, target: BoardTarget): number {
  const walk = target.final && run.alight.walkMeters !== null
    ? (run.alight.walkMeters * WALK_DETOUR) / WALK_METERS_PER_SECOND
    : 0;
  return Date.parse(run.arrives) + walk * 1000;
}

function optionFor(
  stop: Omit<NearbyStopBoard, 'departures'>,
  runs: readonly StationRun[],
  current: boolean,
  from: { lat: number; lon: number },
  target: BoardTarget,
  nowMs: number,
): NearbyOption {
  const walkSeconds = walkSecondsBetween(from, stop);
  const catchable = runs.filter((run) => Date.parse(run.departs) >= nowMs + (walkSeconds + CATCH_MARGIN_SECONDS) * 1000);
  let best: StationRun | null = null;
  let bestReaches: number | null = null;
  for (const run of catchable) {
    const reaches = reachesMs(run, target);
    if (bestReaches === null || reaches < bestReaches) {
      best = run;
      bestReaches = reaches;
    }
  }
  return {
    stopId: stop.stopId, name: stop.name, lat: stop.lat, lon: stop.lon, stationKind: stop.stationKind, rail: stop.rail,
    current, walkSeconds, best, reachesMs: bestReaches, runs: catchable,
  };
}

/**
 * Every stop around the ride's station, ranked by when it gets the rider to
 * the step's end, and the one (if any) the map should call out.
 *
 * `from` is where the rider is (or the planned stop, without a fix): the walk
 * to each stop decides which of its runs can still be caught.
 */
export function rankNearby(args: {
  leg: TransitLeg;
  target: BoardTarget;
  currentRuns: readonly StationRun[];
  boards: readonly NearbyStopBoard[];
  from: { lat: number; lon: number };
  nowMs: number;
}): NearbyOptions {
  const { leg, target, currentRuns, boards, from, nowMs } = args;
  const plannedStop = leg.from.stop;
  const current = optionFor(
    { stopId: plannedStop.stopId ?? '', name: plannedStop.name ?? null, lat: plannedStop.lat, lon: plannedStop.lon },
    currentRuns, true, from, target, nowMs,
  );
  const others = boards
    .filter((board) => board.stopId !== plannedStop.stopId)
    .map((board) => optionFor(board, stationRuns(board.departures, leg, target, nowMs), false, from, target, nowMs));

  const options = [current, ...others].sort((a, b) => {
    if (a.reachesMs === null) return b.reachesMs === null ? 0 : 1;
    if (b.reachesMs === null) return -1;
    return a.reachesMs - b.reachesMs;
  });

  const challenger = options.find((option) => !option.current && option.reachesMs !== null) ?? null;
  let strong: NearbyOption | null = null;
  let gainSeconds: number | null = null;
  if (challenger && challenger.reachesMs !== null) {
    if (current.reachesMs === null) {
      strong = challenger;
    } else {
      const gain = (current.reachesMs - challenger.reachesMs) / 1000;
      if (gain >= STRONG_GAIN_SECONDS) {
        strong = challenger;
        gainSeconds = Math.round(gain);
      }
    }
  }
  return { options, strong, gainSeconds };
}

function walkTo(from: Place, to: Place): WalkLeg {
  const distanceMeters = Math.round(haversineMeters(from, to) * WALK_DETOUR);
  return {
    type: 'walk', from, to, distanceMeters,
    durationSeconds: Math.round(distanceMeters / WALK_METERS_PER_SECOND),
    geometry: null,
    walkEstimated: true,
  };
}

/**
 * The itinerary with this ride boarded somewhere else: the run's own ride in
 * its place (see `withRun`), and the walk to it starting where the walk
 * before it started, or a new one from the planned stop when the ride had no
 * walk before it (straight off a train, or at the journey's start).
 *
 * `walkIndex` is the leg the rider is now on, walking to the new stop.
 */
export function withBoardingElsewhere(
  itinerary: Itinerary,
  legIndex: number,
  leg: TransitLeg,
): { itinerary: Itinerary; walkIndex: number } | null {
  const planned = itinerary.legs[legIndex];
  if (planned?.type !== 'transit') return null;
  const swapped = withRun(itinerary, legIndex, leg);
  const legs = [...swapped.legs];
  const before = legs[legIndex - 1];
  let walkIndex: number;
  if (before?.type === 'walk') {
    legs[legIndex - 1] = walkTo(before.from, leg.from.stop);
    walkIndex = legIndex - 1;
  } else {
    legs.splice(legIndex, 0, walkTo(planned.from.stop, leg.from.stop));
    walkIndex = legIndex;
  }
  const walks = legs.filter((each): each is WalkLeg => each.type === 'walk');
  return {
    itinerary: {
      ...swapped,
      legs,
      walkSeconds: walks.reduce((sum, each) => sum + each.durationSeconds, 0),
      walkMeters: walks.reduce((sum, each) => sum + each.distanceMeters, 0),
    },
    walkIndex,
  };
}
