import type { ActiveJourney, AlertSettings } from './types';

/** Long enough that a rider reaching for a bag has stopped hearing the first
 *  alert, short enough to still be one stop of warning. */
export const ALERT_REPEAT_DELAY_SECONDS = 30;

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
