import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { JourneyPhase, RiderPosition } from './types';

/**
 * The location tier between the foreground watch and the geofences: for the
 * whole journey, keep following the rider with the phone in a pocket, so the
 * Lock Screen moves on with them and its "3 stops, next: Allenby" stays true.
 *
 * Stable across releases, like the geofence task's name: the OS keeps the
 * registration under it.
 */
export const RIDE_LOCATION_TASK = 'freebus.journey.ride-location';

/**
 * The phases this tier runs in: the whole journey, walks included. GPS is
 * what moves the journey on (see `trackLegIndex`, `hasLeftBoarding`), so a
 * walk finished with the phone in a pocket has to reach the station too.
 * Reported from the field: standing in HaShalom, the Lock Screen still said
 * "leave now, 8 min walk". The geofences alone wake too coarsely for that.
 *
 * Starting at the first walk also suits iOS, which only starts background
 * updates for a rider who granted "While Using" while the app is on screen:
 * Start is pressed on screen, and the updates carry on from there.
 */
export const RIDE_PHASES: ReadonlySet<JourneyPhase> = new Set([
  'walking-to-stop', 'waiting', 'riding', 'alight-soon', 'transferring', 'arriving', 'off-plan',
]);

/**
 * High, not Balanced: GPS is what moves the journey on, and Balanced hands
 * back cell and Wi-Fi fixes hundreds of metres wide inside a station or a
 * train carriage, exactly where boarding has to be seen. Reported from the
 * field: on the train past Hadera the journey still waited at the station.
 * `distanceInterval` because a bus at a red light has nothing new to say.
 * Never auto-paused: iOS reads a long stop at a light as the trip being over
 * and would go quiet until the rider unlocked the phone.
 */
const RIDE_UPDATES: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.High,
  distanceInterval: 40,
  activityType: Location.ActivityType.OtherNavigation,
  pausesUpdatesAutomatically: false,
  // The blue pill for a rider who granted only "While Using": the price iOS
  // asks for locating them in the background, and an honest one.
  showsBackgroundLocationIndicator: true,
};

let listener: ((fix: RiderPosition) => void) | null = null;

/**
 * Module scope, like the geofence task: the OS delivers into whatever JS
 * runtime is alive. While the app is running (on screen or not) the provider
 * is listening and the fix moves the journey. A headless wake has no provider
 * and drops the fix; the geofences already own the alarm in that case.
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(RIDE_LOCATION_TASK, async ({ data, error }) => {
  if (error || !listener) return;
  const latest = data?.locations.at(-1);
  if (!latest) return;
  listener({
    lat: latest.coords.latitude,
    lon: latest.coords.longitude,
    accuracyMeters: latest.coords.accuracy ?? Number.POSITIVE_INFINITY,
    at: new Date(latest.timestamp).toISOString(),
  });
});

/** Routes ride fixes to `next` until the returned function is called. */
export function setRideFixListener(next: (fix: RiderPosition) => void): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/**
 * Starts the ride tier, or does nothing if it is already running. False when
 * the OS refused: no background permission on Android, or "While Using" on an
 * iOS app that is not on screen. The journey then runs on the timetable while
 * the phone is locked, which every surface already labels as scheduled.
 */
export async function startRideUpdates(): Promise<boolean> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) return true;
    await Location.startLocationUpdatesAsync(RIDE_LOCATION_TASK, RIDE_UPDATES);
    return true;
  } catch {
    return false;
  }
}

export async function stopRideUpdates(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK);
    }
  } catch {
    // Nothing registered is the state being asked for.
  }
}
