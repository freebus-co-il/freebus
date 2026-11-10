import type { TransitLeg } from '@/api/types';
import { haversineMeters } from '@/lib/geo';

import type { ActiveJourney, AlertSettings } from './types';
import { DEFAULT_ALERT_SETTINGS } from './types';

/** Long enough that a rider reaching for a bag has stopped hearing the first
 *  alert, short enough to still be one stop of warning. */
export const ALERT_REPEAT_DELAY_SECONDS = 30;

/** The smallest ring worth drawing: iOS geofences tighter than this fire late
 *  or not at all, and GPS in a street canyon cannot resolve less either. */
export const MIN_ALIGHT_RADIUS_METERS = 150;

/** How far past the stop before the rider's the vehicle must be to have left
 *  it, rather than be standing at it: a bus stop's length, or most of a train
 *  platform's from the point the feed puts the station at. A fix less accurate
 *  than this needs its own error cleared instead. */
export const PASSED_STOP_METERS = 200;

/** How long before the stop a stop-count alert means to warn: the rider's
 *  lead time, once per stop of warning they asked for. */
export function warningSeconds(settings: AlertSettings): number {
  return settings.leadSeconds * Math.max(1, settings.leadStops);
}

/**
 * The ride's own average speed: the distance through its stops over its
 * timetabled time. This is what turns the warning time into a distance, with
 * nothing known about the mode: a city bus, an intercity bus, the light rail
 * and an express train each come out at their own speed. Time standing at
 * stops is in the average, so it reads a little slow, which errs towards a
 * smaller ring and a later alert, never an early one.
 *
 * Null when the timetable gives no usable time to divide by.
 */
export function rideMetersPerSecond(leg: TransitLeg): number | null {
  const stops = [leg.from.stop, ...leg.intermediateStops, leg.to.stop];
  let meters = 0;
  for (let index = 1; index < stops.length; index += 1) meters += haversineMeters(stops[index - 1]!, stops[index]!);
  const seconds = (Date.parse(leg.to.arrivalTime) - Date.parse(leg.from.departureTime)) / 1000;
  return seconds > 0 && meters > 0 ? meters / seconds : null;
}

/**
 * How close to the alight stop the vehicle has to be before it is time to get
 * off. One rule for every vehicle, with nothing in it that asks which:
 *
 * 1. the vehicle has PASSED the stop before the rider's (`leadStops` stops
 *    before, in general), and
 * 2. it is within `warningSeconds` of the rider's stop, at the ride's own
 *    average speed (`rideMetersPerSecond`).
 *
 * Both halves are one radius around the alight stop: smaller than the gap to
 * the stop before (less `PASSED_STOP_METERS`, or the fix's error if worse), so
 * being inside it means that stop is behind the vehicle, and never larger than
 * the warning distance. The same ring is the geofence the OS watches with the
 * app asleep (see `geofences.ts`), so the two triggers agree about where the
 * moment is.
 *
 * Position decides, never the timetable: a late vehicle reaches its scheduled
 * time stops early.
 */
export function alightRadiusMeters(
  leg: TransitLeg,
  settings: AlertSettings = DEFAULT_ALERT_SETTINGS,
  accuracyMeters = 0,
): number {
  const stops = [leg.from.stop, ...leg.intermediateStops, leg.to.stop];
  const lead = Math.max(1, settings.leadStops);
  const warnFrom = stops[Math.max(0, stops.length - 1 - lead)]!;
  const passed = haversineMeters(warnFrom, leg.to.stop) - Math.max(PASSED_STOP_METERS, accuracyMeters);
  const speed = rideMetersPerSecond(leg);
  // No usable timetable: the stop before alone decides.
  const reach = speed === null ? passed : speed * warningSeconds(settings);
  return Math.max(MIN_ALIGHT_RADIUS_METERS, Math.min(reach, passed));
}

/** Whether a fix is inside `alightRadiusMeters` of the ride's alight stop. */
export function isNearAlightStop(
  leg: TransitLeg,
  point: { lat: number; lon: number; accuracyMeters?: number },
  settings: AlertSettings = DEFAULT_ALERT_SETTINGS,
): boolean {
  const accuracy = Number.isFinite(point.accuracyMeters) ? point.accuracyMeters! : 0;
  return haversineMeters(point, leg.to.stop) <= alightRadiusMeters(leg, settings, accuracy);
}

/**
 * One scheduled local notification.
 *
 * These are the SECOND of the get-off alarm's two triggers. The first is a
 * geofence on the wake ring (see `geofences.ts`); this one fires with no code
 * running at all. Whichever lands first cancels the other. A get-off alarm
 * that fails once is never trusted again, so it gets two independent paths.
 */
export type PlannedAlert = {
  id: string;
  kind: 'alight';
  legIndex: number;
  fireAt: string;
  /** Resolved by the caller through i18n -- these are KEYS, not copy. */
  titleKey: string;
  bodyStopName: string;
};

/**
 * Whether a ride's get-off alarm should be armed with the OS (the scheduled
 * notifications here, the wake ring in `geofences.ts`).
 *
 * Under GPS, only the ride the rider is aboard: until GPS has seen them leave
 * the station on it, the ride's run is the station board's best guess, and an
 * alarm for its stops fires for a bus they never took. Reported from the
 * field: waiting for whichever line came first, the rider was told to get off
 * at the 69's stops.
 *
 * `gpsFollowing` is false when nothing will see the boarding happen with the
 * app out of sight (the background location tier is off): then, and on a
 * journey no fix has ever placed, every ride is armed from the start, as the
 * only alarm there can be.
 */
export function isAlarmedRide(journey: ActiveJourney, legIndex: number, gpsFollowing: boolean): boolean {
  if (!gpsFollowing || (journey.gpsLegIndex ?? null) === null) return true;
  return (journey.boardedLegIndex ?? null) === legIndex;
}

/**
 * When to shout, for every ride whose alarm is armed (see `isAlarmedRide`).
 *
 * Scheduled from the ride's own times, because nothing else is knowable ahead
 * -- the geofence is what makes it accurate when the bus runs late. The
 * repeat is a second scheduled notification rather than a runtime timer, so it
 * survives the app being suspended or killed between the two.
 */
export function planAlightAlerts(journey: ActiveJourney, settings: AlertSettings, gpsFollowing = true): PlannedAlert[] {
  const alerts: PlannedAlert[] = [];

  journey.itinerary.legs.forEach((leg, legIndex) => {
    if (leg.type !== 'transit' || !isAlarmedRide(journey, legIndex, gpsFollowing)) return;
    // A ride GPS has the rider aboard is alarmed by position (the wake ring
    // asleep, the machine's `alight-soon` open; see `alightRadiusMeters`). A
    // timetabled alert would fire early on anything running late. Off GPS it
    // stays, as the only alarm.
    if (gpsFollowing && (journey.boardedLegIndex ?? null) === legIndex) return;
    const arrival = new Date(leg.to.arrivalTime).getTime();
    const stopName = leg.to.stop.name ?? '';

    const fire = (offsetSeconds: number, suffix: string) => ({
      id: `${journey.id}:alight:${legIndex}:${suffix}`,
      kind: 'alight' as const,
      legIndex,
      fireAt: new Date(arrival - offsetSeconds * 1000).toISOString(),
      titleKey: 'journey.alert.getOffNow',
      bodyStopName: stopName,
    });

    // The repeat is NOT opt-in. One alert is missable in a bag or under a
    // coat, and a get-off alarm that fails once is never trusted again -- so
    // the default schedules a second one regardless. `repeatUntilAcknowledged`
    // does not turn repeating ON, it removes the limit of one, for riders who
    // expect to be asleep.
    const offsets = [settings.leadSeconds];
    let next = settings.leadSeconds - ALERT_REPEAT_DELAY_SECONDS;
    while (next > 0) {
      offsets.push(next);
      if (!settings.repeatUntilAcknowledged) break;
      next -= ALERT_REPEAT_DELAY_SECONDS;
    }

    // Past the arrival there is nothing left to warn about, which is what
    // bounds the loop -- these are scheduled notifications, and one that
    // fires after the rider has already sailed past their stop is noise.
    offsets.forEach((offset, index) => {
      alerts.push(fire(offset, index === 0 ? 'first' : `repeat-${index}`));
    });
  });

  return alerts;
}
