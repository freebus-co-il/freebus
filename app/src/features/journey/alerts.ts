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
 * When to shout, for every ride in the journey.
 *
 * Scheduled from the TIMETABLE, because that is all that is knowable at start
 * time -- the geofence is what makes it accurate when the bus runs late. The
 * repeat is a second scheduled notification rather than a runtime timer, so it
 * survives the app being suspended or killed between the two.
 */
export function planAlightAlerts(journey: ActiveJourney, settings: AlertSettings): PlannedAlert[] {
  const alerts: PlannedAlert[] = [];

  journey.itinerary.legs.forEach((leg, legIndex) => {
    if (leg.type !== 'transit') return;
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
