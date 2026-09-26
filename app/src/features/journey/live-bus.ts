import type { LiveVehicle, TransitLeg, TripDetail } from '@/api/types';
import {
  alignStopTimesToRun, busReachedStopIndex, busStopIndex, type RelevantStopInput,
} from '@/features/lines/first-relevant-stop';

/** Where a live bus is relative to the rider's own leg on it, in stops. */
export type LiveBusProgress =
  | { kind: 'toBoarding'; stops: number }
  | { kind: 'toAlighting'; stops: number };

/**
 * How many stops the bus still has before the rider's stop -- or, once it is
 * past that, before the stop they get off at.
 *
 * Only ever from a LIVE position: this answers "where is the bus I am
 * watching", and a timetable guess dressed up as that answer is worse than
 * none. Null past the alighting stop too, where the bus no longer has
 * anything to do with this journey.
 */
export function liveBusProgress(
  input: RelevantStopInput & { alightingIndex: number },
): LiveBusProgress | null {
  const { boardingIndex, alightingIndex, bus, stops } = input;
  if (bus === null || boardingIndex < 0 || stops.length === 0) return null;
  // Two different questions, and answering both with the nearest stop is what
  // made the alarm fire early. WHICH count this is -- still coming to the
  // rider's stop, or past it and counting to where they get off -- is a
  // question about where the bus is, and `busStopIndex` is the order-aware
  // answer to that. HOW MANY stops are left is a question about what the bus
  // has already called at, which `busReachedStopIndex` answers and which is a
  // stop further back for the whole second half of every gap.
  const at = busStopIndex(input);
  const reached = busReachedStopIndex(input);
  if (at <= boardingIndex) return { kind: 'toBoarding', stops: boardingIndex - reached };
  if (alightingIndex >= 0 && at <= alightingIndex) return { kind: 'toAlighting', stops: alightingIndex - reached };
  return null;
}

/** A leg's end in its trip's stop list: by `stopSequence`, which is exact,
 *  falling back to the stop id for a feed whose sequences disagree. */
function legStopIndex(trip: TripDetail, end: { stop: { stopId?: string }; stopSequence: number }): number {
  const bySequence = trip.stops.findIndex((s) => s.stopSequence === end.stopSequence && s.stop.stopId === end.stop.stopId);
  if (bySequence >= 0) return bySequence;
  return end.stop.stopId === undefined ? -1 : trip.stops.findIndex((s) => s.stop.stopId === end.stop.stopId);
}

/**
 * `liveBusProgress` for one leg of a journey, from the leg's full trip.
 *
 * The trip's stop times are re-dated onto the leg's own departure first, for
 * the reason `alignStopTimesToRun` documents: the trip endpoint can render
 * them against another day, and the timetable is what keeps a bus on a loop
 * from being matched to the wrong side of it.
 */
export function legBusProgress(
  trip: TripDetail, leg: TransitLeg, vehicle: LiveVehicle | null, now: Date,
): LiveBusProgress | null {
  const boardingIndex = legStopIndex(trip, leg.from);
  const alightingIndex = legStopIndex(trip, leg.to);
  const anchor = boardingIndex < 0
    ? null
    : (trip.stops[boardingIndex]!.departureTime ?? trip.stops[boardingIndex]!.arrivalTime);
  const times = alignStopTimesToRun(
    trip.stops.map((s) => s.departureTime ?? s.arrivalTime),
    anchor,
    leg.from.departureTime,
  );
  return liveBusProgress({
    stops: trip.stops.map((s, index) => ({ lat: s.stop.lat, lon: s.stop.lon, time: times[index] ?? null })),
    boardingIndex,
    alightingIndex,
    bus: vehicle === null ? null : { lat: vehicle.lat, lon: vehicle.lon },
    now,
  });
}
