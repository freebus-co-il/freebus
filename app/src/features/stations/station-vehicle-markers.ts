import type { Departure, LiveVehicle } from '@/api/types';
import { etaMinutes, lineVehicleMarkers, type VehicleMarker } from '@/features/results/vehicle-markers';

import { lineKey } from './station-line';

/** `GET /vehicles` answers at most 12 trips per request -- the board's first
 *  twelve are the buses a rider at this stop is actually waiting for. */
export const STATION_VEHICLE_LIMIT = 12;

/** The board's next trips, each once, for the station map's vehicle poll. */
export function stationTripIds(departures: readonly Departure[]): string[] {
  return [...new Set(departures.map((d) => d.tripId))].slice(0, STATION_VEHICLE_LIMIT);
}

/**
 * The buses heading to this stop, each drawn in its own line's colour and
 * counting down to this stop -- by the board's live prediction when it has one,
 * the timetable when not.
 *
 * Joined on trip id against the board, so a vehicle from a previous board --
 * a cached response that outlived its departures -- draws nothing rather than
 * a bus nobody can match to a row.
 */
export function stationVehicleMarkers(
  departures: readonly Departure[], vehicles: readonly LiveVehicle[], now: Date,
): VehicleMarker[] {
  const byTrip = new Map(departures.map((d) => [d.tripId, d] as const));
  return vehicles.flatMap((vehicle) => {
    const departure = byTrip.get(vehicle.tripId);
    if (departure === undefined) return [];
    return lineVehicleMarkers([vehicle], departure.route, now).map((marker) => ({
      ...marker,
      etaMinutes: etaMinutes(
        [{ predicted: departure.realtime?.predictedDeparture ?? null, scheduled: departure.departureTime }], now,
      ),
    }));
  });
}

/** One badge per line at a stop: the feed lists a line once per route row
 *  (direction, alternative), and a strip of three identical "18"s says less
 *  than one. */
export function stationLines<T extends { agencyId: string | null; shortName: string | null; type: number }>(
  routes: readonly T[],
): T[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = lineKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
