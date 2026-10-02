import { init, trackEvent } from '@aptabase/react-native';
import Constants from 'expo-constants';
import { AppState, Platform, type AppStateStatus } from 'react-native';

/**
 * Usage counting, and deliberately nothing more.
 *
 * What leaves the phone is a handful of named events (`AnalyticsEvent`), each
 * a bare count with no properties of our own. Aptabase adds the OS and its
 * version, the app version, and a session id that lives in memory only and
 * rotates after an hour idle. There is no device or user identifier, nothing is persisted, and
 * the SDK reports every rider's locale as `en-US`. Aptabase derives a country
 * from the request IP server-side and does not store the IP.
 *
 * Never add properties or events that describe WHERE a rider is or is going:
 * no stop ids, line numbers, coordinates, place names, search text or route
 * names -- that includes screen names, since a route like `/station/123` is a
 * stop id. If a number is worth knowing, it has to be worth it without them.
 *
 * Off unless all of these hold: a release build (`__DEV__` builds send
 * nothing), a native platform (no web), and `EXPO_PUBLIC_APTABASE_APP_KEY` set,
 * which only `.env.production` does -- so a fork of this repo reports nowhere.
 * Crash reporting is left off: a stack trace can carry whatever was in scope.
 *
 * The SDK has a native module (for the app version), but its JS falls back
 * cleanly without it, so an over-the-air update reaching a binary built
 * before this existed sends events rather than crashing -- which is why the
 * app version is passed in from the config instead of trusted to it.
 */
const APP_KEY = process.env.EXPO_PUBLIC_APTABASE_APP_KEY;

let started = false;

/**
 * Everything the app counts. A closed list on purpose: `countEvent` takes no
 * properties, so adding a line here is the only way to count something new.
 *
 * - `app_opened`: a cold start or a return from the background (below).
 * - `trip_planned`: the rider issued a search -- once per from/to pair, not
 *   per fetch, so refetches and a changed departure time do not inflate it.
 * - `journey_started`: Start pressed on a live journey, a replacement one
 *   picked mid-journey included.
 * - `journey_completed`: a journey reached its end, by GPS or by the clock.
 * - `journey_cancelled`: a journey that did NOT reach its end -- the rider
 *   pressed End, or started another journey over it (a mid-journey replan
 *   included). With `journey_completed` this accounts for every start.
 */
export type AnalyticsEvent =
  | 'app_opened'
  | 'trip_planned'
  | 'journey_started'
  | 'journey_completed'
  | 'journey_cancelled';

/** Fire-and-forget, and a no-op wherever `initAnalytics` declined to start. */
export function countEvent(name: AnalyticsEvent): void {
  if (!started) return;
  try {
    trackEvent(name);
  } catch {
    // Counting is never the point of anything it sits beside.
  }
}

export function initAnalytics(): void {
  if (started || __DEV__ || Platform.OS === 'web' || !APP_KEY) return;
  started = true;

  try {
    init(APP_KEY, { appVersion: Constants.expoConfig?.version });
  } catch {
    started = false;
    return;
  }

  // Not when the JS was started in the background (a journey's location task
  // waking the app): that is not the rider opening it.
  if (AppState.currentState !== 'background') countEvent('app_opened');

  // From `background` only: iOS passes through `inactive` for a pulled-down
  // notification shade or Control Center, which is not an open either.
  let previous: AppStateStatus = AppState.currentState;
  AppState.addEventListener('change', (next) => {
    if (previous === 'background' && next === 'active') countEvent('app_opened');
    previous = next;
  });
}
