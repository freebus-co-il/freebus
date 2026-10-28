import type { Departure, Itinerary, Place, TransitLeg, TripDetail, TripStopTime, WalkLeg } from '@/api/types';
import { haversineMeters } from '@/lib/geo';

import { modeFamily, SAME_STATION_METERS, type ModeFamily } from './replan/backbone';

/**
 * A journey is its stations, not its runs. At a station the rider takes
 * whichever run gets them to the next station (or, on the last ride, close
 * enough to the destination), so the step shows the station's own board cut
 * to those runs, and the journey follows whichever one is coming next.
 *
 * Missing a run is therefore not an event at all: it drops off the board and
 * the next one takes its place. And a run that is late stays on the board
 * (the server keeps a late run there while realtime says it is still coming),
 * so it is not swapped for the next one just because its timetable slot went.
 */

/** A city walk at a rider's pace, with the corners a straight line ignores.
 *  The same allowance the sheet's walking verdict uses. */
const WALK_METERS_PER_SECOND = 1.2;
const WALK_DETOUR = 1.3;

/** A run whose boardable time is this far behind now may still be standing at
 *  the platform with its doors open. */
export const BOARD_GRACE_SECONDS = 60;

/** Where a ride step is going, which decides which runs on the board count. */
export type BoardTarget = {
  /** The point the board is filtered to: the next station, or the place the
   *  rider is going on the last ride. */
  lat: number;
  lon: number;
  /** The last ride: any line that stops near the destination will do. */
  final: boolean;
  /** Before the last ride, only the same kind of vehicle: a rider who chose
   *  the train is not offered a bus that happens to stop near the station. */
  mode: ModeFamily;
};

export function isFinalRide(itinerary: Itinerary, legIndex: number): boolean {
  return !itinerary.legs.slice(legIndex + 1).some((leg) => leg.type === 'transit');
}

/**
 * What the board for this ride is filtered to. Null when the leg is not a ride
 * from a known stop, which no board can be asked about.
 */
export function boardTarget(itinerary: Itinerary, legIndex: number): BoardTarget | null {
  const leg = itinerary.legs[legIndex];
  if (leg?.type !== 'transit' || !leg.from.stop.stopId) return null;
  const final = isFinalRide(itinerary, legIndex);
  const last = itinerary.legs[itinerary.legs.length - 1];
  const point = final && last?.type === 'walk' ? last.to : leg.to.stop;
  return { lat: point.lat, lon: point.lon, final, mode: modeFamily(leg.route.type) };
}

/** One run the rider could take from this station. */
export type StationRun = {
  /** Unique per row: a loop line can call at the station twice. */
  key: string;
  tripId: string;
  route: Departure['route'];
  headsign: string;
  tripNumber: string | null;
  boardStopId: string;
  boardStopSequence: number;
  /** When it can be boarded: the live prediction when there is one. */
  departs: string;
  live: boolean;
  realtime: Departure['realtime'];
  alight: { stopId: string; stopSequence: number; name: string | null; walkMeters: number | null };
  arrives: string;
  rideSeconds: number;
};

function boardableTime(departure: Departure): string {
  return departure.realtime?.predictedDeparture ?? departure.departureTime;
}

function toRun(departure: Departure): StationRun | null {
  const destination = departure.destination;
  if (!destination) return null;
  return {
    key: `${departure.runId}:${departure.stopSequence}`,
    tripId: departure.tripId,
    route: departure.route,
    headsign: departure.headsign,
    tripNumber: departure.tripNumber ?? null,
    boardStopId: departure.stopId,
    boardStopSequence: departure.stopSequence,
    departs: boardableTime(departure),
    live: departure.realtime?.predictedDeparture != null,
    realtime: departure.realtime,
    alight: {
      stopId: destination.stopId,
      stopSequence: destination.stopSequence,
      name: destination.name ?? null,
      walkMeters: destination.walkMeters ?? null,
    },
    arrives: destination.arrivalTime,
    rideSeconds: destination.rideSeconds,
  };
}

/**
 * The runs on a station's board that make this step, soonest first.
 *
 * Before the last ride a run has to stop at the very station the next step
 * starts from (its own stop, or one within a station's span of it) and be the
 * same kind of vehicle. On the last ride, every line the server says stops
 * near the destination counts: which one is the rider's call, and the board
 * shows where each sets them down and how far that leaves to walk.
 */
export function stationRuns(
  departures: readonly Departure[],
  leg: TransitLeg,
  target: BoardTarget,
  nowMs: number,
): StationRun[] {
  return departures
    .map(toRun)
    .filter((run): run is StationRun => run !== null)
    .filter((run) => Date.parse(run.departs) >= nowMs - BOARD_GRACE_SECONDS * 1000)
    .filter((run) => target.final || (
      modeFamily(run.route.type) === target.mode &&
      (run.alight.stopId === leg.to.stop.stopId || (run.alight.walkMeters ?? Number.POSITIVE_INFINITY) <= SAME_STATION_METERS)
    ))
    .sort((a, b) => Date.parse(a.departs) - Date.parse(b.departs));
}

/** How long past due the ride holds on to its run once the board has dropped
 *  it. The board keeps a late run only while realtime vouches for it, and
 *  trains here are late far more often than realtime says: without this the
 *  ride moved to the next train while the rider watched the late one pull in. */
export const LATE_HOLD_SECONDS = 5 * 60;

/**
 * The run the journey should switch its ride to while the rider waits, or
 * null to keep it.
 *
 * The ride keeps its run for as long as that run is still on the board: the
 * plan may have picked a faster run over a slower one leaving first, and a
 * late run is still on the board. Only once it is gone, and `LATE_HOLD_SECONDS`
 * past due, does the ride move to whatever comes next.
 */
export function runToFollow(leg: TransitLeg, runs: readonly StationRun[], nowMs: number): StationRun | null {
  if (runs.length === 0) return null;
  if (runs.some((run) => run.tripId === leg.tripId)) return null;
  const legDeparts = Date.parse(leg.realtime?.predictedDeparture ?? leg.from.departureTime);
  if (nowMs - legDeparts < LATE_HOLD_SECONDS * 1000) return null;
  return runs[0]!;
}

/**
 * The run a rider GPS has just seen leave the station is on, when it is not
 * the one the ride names: the latest run that could have been boarded by now.
 * `seen` is every run the board has shown for this ride, so a late train that
 * already dropped off it is still a candidate.
 */
export function boardedRun(leg: TransitLeg, seen: readonly StationRun[], nowMs: number): StationRun | null {
  const legDeparts = Date.parse(leg.realtime?.predictedDeparture ?? leg.from.departureTime);
  // The ride's own run leaving about now is the run they are on.
  if (legDeparts <= nowMs + BOARD_GRACE_SECONDS * 1000) return null;
  return [...seen]
    .filter((run) => run.tripId !== leg.tripId && Date.parse(run.departs) <= nowMs + BOARD_GRACE_SECONDS * 1000)
    .sort((a, b) => Date.parse(b.departs) - Date.parse(a.departs))[0] ?? null;
}

/**
 * Every run seen so far for a ride, plus the board's latest, by key and in
 * departure order, without those due before `forgetBeforeMs`.
 */
export function rememberRuns(seen: readonly StationRun[], latest: readonly StationRun[], forgetBeforeMs: number): StationRun[] {
  const byKey = new Map(seen.map((run) => [run.key, run] as const));
  for (const run of latest) byKey.set(run.key, run);
  return [...byKey.values()]
    .filter((run) => Date.parse(run.departs) >= forgetBeforeMs)
    .sort((a, b) => Date.parse(a.departs) - Date.parse(b.departs));
}

function stopPlace(stop: TripStopTime['stop']): Place {
  return { type: 'stop', lat: stop.lat, lon: stop.lon, stopId: stop.stopId, name: stop.name ?? undefined };
}

/**
 * The ride as the run makes it: its own stops between the station and where
 * it sets the rider down, at its own times. Null when the trip does not call
 * at both, which means the trip read back is not the run on the board.
 */
export function legFromRun(run: StationRun, trip: TripDetail, planned: TransitLeg): TransitLeg | null {
  const from = trip.stops.findIndex((stop) => stop.stopSequence === run.boardStopSequence);
  const to = trip.stops.findIndex((stop) => stop.stopSequence === run.alight.stopSequence);
  if (from < 0 || to <= from) return null;
  const board = trip.stops[from]!;
  const alight = trip.stops[to]!;
  const departureTime = board.departureTime ?? board.arrivalTime;
  const arrivalTime = alight.arrivalTime ?? alight.departureTime;
  if (!departureTime || !arrivalTime) return null;
  // The planned ride's drawn route is this run's too when both run between the
  // same two stops; otherwise the stops join up, as for any ride with no shape.
  const sameStops = planned.from.stop.stopId === board.stop.stopId && planned.to.stop.stopId === alight.stop.stopId;
  return {
    type: 'transit',
    route: {
      id: run.route.routeId,
      agencyId: run.route.agencyId,
      shortName: run.route.shortName ?? '',
      longName: run.route.longName ?? '',
      type: run.route.type,
      color: run.route.color,
    },
    tripId: run.tripId,
    headsign: run.headsign,
    tripNumber: run.tripNumber,
    directionId: trip.directionId,
    from: { stop: stopPlace(board.stop), departureTime, stopSequence: board.stopSequence },
    to: { stop: stopPlace(alight.stop), arrivalTime, stopSequence: alight.stopSequence },
    numStops: to - from,
    intermediateStops: trip.stops.slice(from + 1, to).map((stop) => stopPlace(stop.stop)),
    geometry: sameStops ? planned.geometry : null,
    geometryFallback: sameStops ? planned.geometryFallback : true,
    realtime: run.realtime,
  };
}

/**
 * The itinerary with this ride swapped for another run. When the new run sets
 * the rider down somewhere else (the last ride, a different stop near home),
 * the walk after it starts from there instead, estimated until the walk is
 * re-routed on the street. The arrival follows the new run: exactly on the
 * last ride, and pushed back by its lateness before one, until the re-planner
 * fills in the rides after it.
 */
export function withRun(itinerary: Itinerary, legIndex: number, leg: TransitLeg): Itinerary {
  const previous = itinerary.legs[legIndex];
  if (previous?.type !== 'transit') return itinerary;
  const legs = [...itinerary.legs];
  legs[legIndex] = leg;

  const after = legs[legIndex + 1];
  if (after?.type === 'walk' && previous.to.stop.stopId !== leg.to.stop.stopId) {
    const distanceMeters = Math.round(haversineMeters(leg.to.stop, after.to) * WALK_DETOUR);
    const walk: WalkLeg = {
      type: 'walk',
      from: leg.to.stop,
      to: after.to,
      distanceMeters,
      durationSeconds: Math.round(distanceMeters / WALK_METERS_PER_SECOND),
      geometry: null,
      walkEstimated: true,
    };
    legs[legIndex + 1] = walk;
  }

  const final = isFinalRide(itinerary, legIndex);
  const lastWalk = legs[legIndex + 1];
  const arrivalMs = final
    ? Date.parse(leg.to.arrivalTime) + (lastWalk?.type === 'walk' ? lastWalk.durationSeconds * 1000 : 0)
    : Date.parse(itinerary.arrivalTime) + Math.max(0, Date.parse(leg.to.arrivalTime) - Date.parse(previous.to.arrivalTime));
  const arrivalTime = new Date(arrivalMs).toISOString();
  const walks = legs.filter((each): each is WalkLeg => each.type === 'walk');
  return {
    ...itinerary,
    legs,
    arrivalTime,
    durationSeconds: Math.round((arrivalMs - Date.parse(itinerary.departureTime)) / 1000),
    walkSeconds: walks.reduce((sum, each) => sum + each.durationSeconds, 0),
    walkMeters: walks.reduce((sum, each) => sum + each.distanceMeters, 0),
  };
}
