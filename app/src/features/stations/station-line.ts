import type { Departure, TripDetail } from '@/api/types';
import type { VehicleMarker } from '@/features/results/vehicle-markers';

/** A line as a rider knows it at a stop: its operator, number and kind of
 *  vehicle. The feed lists a line once per route row (direction, alternative),
 *  and all of those are the same line on a station's board. */
export function lineKey(route: { agencyId: string | null; shortName: string | null; type: number }): string {
  return `${route.agencyId ?? ''}|${route.shortName ?? ''}|${route.type}`;
}

/** A departure's identity on the board: its run, paired with its time --
 *  an unscheduled bus shares its template trip's id, and the API can list one
 *  run twice. */
export function departureKey(departure: Pick<Departure, 'runId' | 'departureTime'>): string {
  return `${departure.runId}:${departure.departureTime}`;
}

/** The board's departures of one line, in board order. */
export function lineDepartures(departures: readonly Departure[], key: string): Departure[] {
  return departures.filter((departure) => lineKey(departure.route) === key);
}

export type RunStop = {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  /** ISO-8601, as this run calls there; null when the trip has no time for it. */
  time: string | null;
};

/**
 * A run's stops, timed as THIS run calls at them, and where the station sits
 * among them.
 *
 * The trip endpoint renders stop times against whichever service date it
 * finds first, and an unscheduled bus runs its template trip at an offset --
 * either way the trip's own clock can be hours or a day off the departure on
 * the board. Both are the same correction: shift every time by however far the
 * trip's time at this stop is from the board's departure there, so the station
 * reads exactly as the board does and every other stop follows from it.
 *
 * The station is found by its place in the trip (`stopSequence`), falling back
 * to its id for a feed whose sequences disagree. Unshifted when it is not found
 * at all, with `boardingIndex` -1.
 */
export function runStops(
  trip: TripDetail | undefined,
  at: { stopId: string; stopSequence: number; departureTime: string } | null,
): { stops: RunStop[]; boardingIndex: number } {
  if (!trip || !at) return { stops: [], boardingIndex: -1 };
  let boardingIndex = trip.stops.findIndex((s) => s.stopSequence === at.stopSequence && s.stop.stopId === at.stopId);
  if (boardingIndex < 0) boardingIndex = trip.stops.findIndex((s) => s.stop.stopId === at.stopId);

  const boarding = boardingIndex < 0 ? null : trip.stops[boardingIndex]!;
  const boardingTime = boarding ? (boarding.departureTime ?? boarding.arrivalTime) : null;
  const shiftMs = boardingTime === null ? 0 : new Date(at.departureTime).getTime() - new Date(boardingTime).getTime();

  const stops = trip.stops.map(({ stop, departureTime, arrivalTime }) => {
    const time = departureTime ?? arrivalTime;
    return {
      stopId: stop.stopId,
      name: stop.name ?? stop.stopId,
      lat: stop.lat,
      lon: stop.lon,
      time: time === null ? null : new Date(new Date(time).getTime() + shiftMs).toISOString(),
    };
  });
  return { stops, boardingIndex };
}

/**
 * The station's buses with one line in focus: that line's stay exactly as they
 * are, counting down to this stop, and every other line's step back -- smaller,
 * paler, and without a label, so the map reads as that line's.
 */
export function highlightMarkers(
  markers: readonly VehicleMarker[], departures: readonly Departure[], key: string,
): VehicleMarker[] {
  const keyByTrip = new Map(departures.map((departure) => [departure.tripId, lineKey(departure.route)] as const));
  return markers.map((marker) => (
    keyByTrip.get(marker.tripId) === key
      ? marker
      : { ...marker, secondary: true, faded: true, etaMinutes: null }
  ));
}
