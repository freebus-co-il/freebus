import type { Itinerary, LiveVehicle, TransitLeg } from '@/api/types';
import { routeColor } from '@/lib/route-color';

/** One live vehicle, already matched to the leg it is running. */
export type VehicleMarker = {
  tripId: string;
  latitude: number;
  longitude: number;
  color: string;
  /** GTFS `route_type`, for the glyph a line with no number falls back to --
   *  see `VehicleIcon`. */
  routeType: number;
  /** The line's short name, printed on the marker. Rail routes here mostly
   *  have none, and show the vehicle glyph instead. */
  shortName: string | null;
  /** Whole minutes until this vehicle reaches the rider's stop -- 0 reads as
   *  arriving. Null when there is no stop of the rider's to count to (a line's
   *  own map) or the vehicle is already past it: then nothing is written under
   *  the marker. */
  etaMinutes: number | null;
  /** Drawn dimmed: the report is old enough that the bus has likely moved on
   *  from where the marker sits. */
  faded: boolean;
  /** Drawn smaller: a neighbour of the run the rider is looking at, not that
   *  run itself. Only the line page opened from a station board sets this. */
  secondary: boolean;
};

/**
 * Past this, a marker is drawn dimmed. A bus in city traffic covers a few
 * hundred metres in two minutes -- enough to be past the next stop -- while the
 * raw feed's normal report is about a minute old, so a fresh marker stays at
 * full strength. The server stops sending a keyless position altogether at five.
 */
export const FADE_AFTER_SECONDS = 120;

/** A marker's fade, the one rule every map draws by: dimmed once the report is
 *  older than `FADE_AFTER_SECONDS`. A report with no time, or stamped a little
 *  ahead of the phone's clock, is not faded. */
export function isFaded(recordedAt: string | null, now: Date): boolean {
  if (recordedAt === null) return false;
  const reported = new Date(recordedAt).getTime();
  if (Number.isNaN(reported)) return false;
  return (now.getTime() - reported) / 1000 > FADE_AFTER_SECONDS;
}

/** A report's age in whole minutes, rounded down, with its fade -- for the bus
 *  card, which still says when the position was reported. Null minutes when the
 *  feed gave no report time: saying "now" there would be a guess dressed as a
 *  fact. A report stamped a little ahead of the phone's clock reads as now. */
export function agedness(recordedAt: string | null, now: Date): { ageMinutes: number | null; faded: boolean } {
  if (recordedAt === null) return { ageMinutes: null, faded: false };
  const reported = new Date(recordedAt).getTime();
  if (Number.isNaN(reported)) return { ageMinutes: null, faded: false };
  const ageSeconds = Math.max(0, (now.getTime() - reported) / 1000);
  return { ageMinutes: Math.floor(ageSeconds / 60), faded: isFaded(recordedAt, now) };
}

/** When a vehicle reaches a stop: as the live feed predicts it, and as the
 *  timetable has it. */
export type StopTime = { predicted: string | null; scheduled: string };

/** A stop's time passed by less than this still counts as the bus arriving
 *  there -- the countdown sits at "arriving" rather than jumping to the next
 *  stop while the doors are open. */
export const PASSED_GRACE_SECONDS = 60;

/**
 * Whole minutes until the vehicle reaches the rider's stop: the first of
 * `stops` it has not yet passed, by the live prediction when there is one and
 * the timetable when not. Null once it is past all of them.
 */
export function etaMinutes(stops: readonly (StopTime | null)[], now: Date): number | null {
  for (const stop of stops) {
    if (stop === null) continue;
    const at = new Date(stop.predicted ?? stop.scheduled).getTime();
    if (Number.isNaN(at)) continue;
    const seconds = (at - now.getTime()) / 1000;
    if (seconds >= -PASSED_GRACE_SECONDS) return Math.max(0, Math.round(seconds / 60));
  }
  return null;
}

/** Live predictions for an itinerary's rides, by leg index. */
export type LegPredictions = ReadonlyMap<number, { departure: string | null; arrival: string | null }>;

const NO_PREDICTIONS: LegPredictions = new Map();

/** The predictions `/plan` attached to an itinerary's own rides -- as fresh as
 *  the plan, which the results and trip screens re-fetch every minute. */
export function itineraryPredictions(itinerary: Itinerary | null): LegPredictions {
  const predictions = new Map<number, { departure: string | null; arrival: string | null }>();
  itinerary?.legs.forEach((leg, index) => {
    if (leg.type === 'transit' && leg.realtime) {
      predictions.set(index, { departure: leg.realtime.predictedDeparture, arrival: leg.realtime.predictedArrival });
    }
  });
  return predictions;
}

export type VehicleMarkerOptions = {
  /** Live times for the rides, by leg index; the timetable fills any gap. */
  predictions?: LegPredictions;
  /**
   * The rider is on this journey, not previewing it: once a bus is past the
   * stop they board at, count to the one they get off at. A preview stops
   * counting instead -- a bus that has left their stop is not one they are on.
   */
  towardsAlighting?: boolean;
};

/**
 * The vehicles that belong on THIS map, coloured by the leg each one is
 * running, each counting down to the rider's own stop on it.
 *
 * Matched on `tripId` against the itinerary's own transit legs, so a response
 * naming a trip this rider is not on -- a cache entry from the journey they
 * just left, say -- draws nothing rather than a mystery bus. That puts the
 * join here rather than on the caller: the itinerary is the only thing that
 * knows which colour a given trip's marker should be and which stop it is
 * counting to.
 *
 * Its own module, apart from `trip-map.tsx`, so it can be tested without a
 * native map: this is the whole of the correctness in drawing a vehicle, and
 * everything around it is presentation.
 */
export function vehicleMarkers(
  itinerary: Itinerary | null, vehicles: readonly LiveVehicle[], now: Date,
  { predictions = NO_PREDICTIONS, towardsAlighting = false }: VehicleMarkerOptions = {},
): VehicleMarker[] {
  if (!itinerary || vehicles.length === 0) return [];

  const legByTripId = new Map<string, { leg: TransitLeg; index: number }>();
  itinerary.legs.forEach((leg, index) => {
    if (leg.type === 'transit') legByTripId.set(leg.tripId, { leg, index });
  });

  const markers: VehicleMarker[] = [];
  for (const vehicle of vehicles) {
    const match = legByTripId.get(vehicle.tripId);
    if (match === undefined) continue;
    const { leg, index } = match;
    const predicted = predictions.get(index);
    markers.push({
      tripId: vehicle.tripId,
      latitude: vehicle.lat,
      longitude: vehicle.lon,
      color: routeColor(leg.route),
      routeType: leg.route.type,
      shortName: leg.route.shortName,
      etaMinutes: etaMinutes([
        { predicted: predicted?.departure ?? null, scheduled: leg.from.departureTime },
        towardsAlighting ? { predicted: predicted?.arrival ?? null, scheduled: leg.to.arrivalTime } : null,
      ], now),
      faded: isFaded(vehicle.recordedAt, now),
      secondary: false,
    });
  }
  return markers;
}

/**
 * A line's buses, for the line page's map. No itinerary to join against:
 * `GET /routes/:routeId/vehicles` only ever returns this route's buses, so
 * every one is drawn, all in the line's own colour -- the same colour the
 * shape and the stop spine under it are drawn in. No stop of the rider's to
 * count to, so no label either.
 */
export function lineVehicleMarkers(
  vehicles: readonly LiveVehicle[],
  line: { agencyId: string | null; type: number; shortName: string | null },
  now: Date,
  /** The rider's own run, when the page was opened from a station board:
   *  every other bus is then drawn as its secondary neighbour. */
  primaryTripId: string | null = null,
): VehicleMarker[] {
  const color = routeColor(line);
  return vehicles.map((vehicle) => ({
    tripId: vehicle.tripId,
    latitude: vehicle.lat,
    longitude: vehicle.lon,
    color,
    routeType: line.type,
    shortName: line.shortName,
    etaMinutes: null,
    faded: isFaded(vehicle.recordedAt, now),
    secondary: primaryTripId !== null && vehicle.tripId !== primaryTripId,
  }));
}
