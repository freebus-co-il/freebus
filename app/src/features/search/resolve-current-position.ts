import { haversineMeters } from '@/lib/geo';
import { TIMED_OUT, withTimeout } from '@/lib/with-timeout';

export type Coords = { lat: number; lon: number };

export type CurrentLocationErrorMessage = 'location_permission_denied' | 'location_unavailable';

export type PositionUpdate =
  | { status: 'success'; coords: Coords }
  | { status: 'error'; message: CurrentLocationErrorMessage };

/** What this needs from the device, behind an interface so the ordering and
 *  fallbacks below can be tested without `expo-location`. */
export interface LocationSource {
  /** May show the OS permission prompt. */
  requestPermission(): Promise<boolean>;
  /** Reads the permission without ever showing anything. */
  hasPermission(): Promise<boolean>;
  /** The OS's cached position, or null when it has none fresh enough. */
  lastKnown(): Promise<Coords | null>;
  /** A new fix. May never settle -- the deadline is applied here, not there.
   *  Only when `interactive` may it ask the rider to turn location on. */
  current(interactive: boolean): Promise<Coords>;
}

/**
 * How far a fresh fix has to be from the one already on screen before it is
 * worth reporting. Every report re-keys the nearby-stops query and the smart
 * suggestion's `/plan`, the most expensive request the app makes -- a GPS
 * jitter of a few metres must not cost a second search. Fifty metres is well
 * inside the walk to any stop and well outside a fix settling in place.
 */
export const REFINE_MOVED_METERS = 50;

/**
 * Resolves the device position in the order that fills the home screen
 * fastest:
 *
 * 1. The OS's last known position, reported at once. Cold GPS indoors can
 *    take far longer than the deadline, and a position from a few minutes ago
 *    is almost always right for "which stops are near me".
 * 2. A fresh fix under `timeoutMs`, reported only if it moved.
 *
 * `previous` is the fix already on screen, for a refresh. A refresh never
 * reports an error just because no new fix came -- an older position still
 * beats replacing the screen with a failure. A revoked permission still
 * reports, since that position can no longer be trusted to be followed.
 *
 * `interactive` is whether this may put anything in front of the rider -- the
 * permission prompt, or Android's "turn on location" dialog. A request made
 * because the app came back to the foreground must not: on Android both are
 * activities over the app, and dismissing one is itself a return to the
 * foreground.
 */
export async function resolveCurrentPosition(
  source: LocationSource,
  options: {
    timeoutMs: number;
    previous: Coords | null;
    interactive: boolean;
    onUpdate: (update: PositionUpdate) => void;
  },
): Promise<void> {
  const { timeoutMs, interactive, onUpdate } = options;

  const permitted = interactive ? await source.requestPermission() : await source.hasPermission();
  if (!permitted) {
    onUpdate({ status: 'error', message: 'location_permission_denied' });
    return;
  }

  let shown = options.previous;
  const report = (coords: Coords) => {
    if (shown !== null && haversineMeters(shown, coords) < REFINE_MOVED_METERS) return;
    shown = coords;
    onUpdate({ status: 'success', coords });
  };

  const lastKnown = await source.lastKnown().catch(() => null);
  if (lastKnown !== null) report(lastKnown);

  let fresh: Coords | typeof TIMED_OUT | null;
  try {
    fresh = await withTimeout(source.current(interactive), timeoutMs);
  } catch {
    fresh = null;
  }

  if (fresh !== null && fresh !== TIMED_OUT) {
    report(fresh);
  } else if (shown === null) {
    onUpdate({ status: 'error', message: 'location_unavailable' });
  }
}
