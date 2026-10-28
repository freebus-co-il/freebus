import { NativeModule, requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

import type { JourneyRail } from './journey-rail';
import type { JourneySurfaceCopy } from './surface-copy';
import type { ActiveJourney, JourneyState } from './types';

export type LiveSurfaceAlert = { title: string; body: string; sound: boolean; vibrate: boolean };

export type { JourneySurfaceCopy, SurfaceRide } from './surface-copy';

type LiveSurfaceEvents = {
  /** The rider pressed "Got it" on the Lock Screen or in the shade. Fired by
   *  the native module AFTER it has already silenced itself, so this is only
   *  how the in-app surfaces catch up -- never what makes the noise stop. */
  onAcknowledgeAlight: () => void;
};

/** The emitter half of the native module, declared the way an Expo module's
 *  own types do it: `NativeModule` names a constructor, and only subclassing
 *  it yields an instance type carrying `addListener`. */
declare class LiveSurfaceEmitter extends NativeModule<LiveSurfaceEvents> {}

/**
 * The OS-level presentation of a running journey: the Dynamic Island and Lock
 * Screen on iOS, the status-bar chip and Live Update notification on Android.
 *
 * Deliberately dumb. It renders a `JourneyState` and a `JourneySurfaceCopy`
 * and decides NOTHING -- all phase logic lives in `journey-machine.ts` and all
 * wording in `journey-copy.ts`, so the surfaces (this, the journey bar and the
 * journey screen) cannot drift into disagreeing about the same journey.
 */
export type LiveSurface = {
  start(
    journey: ActiveJourney,
    state: JourneyState,
    rail: JourneyRail,
    copy: JourneySurfaceCopy,
  ): Promise<void>;
  /** Called only at transitions -- never on a tick. Passing `alert` is what
   *  makes the surface break through with sound and haptics, which is
   *  rationed to the three moments in the spec's alert budget. */
  update(state: JourneyState, copy: JourneySurfaceCopy, alert?: LiveSurfaceAlert): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Null on any build whose native module is missing: Expo Go, or
 * a dev client from before the native modules landed.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule` on purpose:
 * the in-app journey is complete on its own, so a missing live surface should
 * cost the rider the Island and nothing else, instead of crashing the app at
 * import time.
 */
const native = requireOptionalNativeModule<LiveSurface & LiveSurfaceEmitter>('LiveJourney');

/**
 * The live surface, or a no-op standing in for it.
 *
 * Callers never branch on platform or on availability: a journey runs the
 * same way whether or not anything is drawing it on the lock screen.
 */
export const liveSurface: LiveSurface = {
  async start(journey, state, rail, copy) {
    await native?.start(withLineNames(journey), withLineName(state), rail, copy);
  },
  async update(state, copy, alert) {
    await native?.update(withLineName(state), copy, alert);
  },
  async stop() {
    await native?.stop();
  },
};

/**
 * A train has no line number, and the planner sends `null` for it, while the
 * native records require a string: passed as is, the Live Activity refused to
 * start for every journey on a train. The surfaces label a train by its own
 * glyph and number, so an empty line name is the honest value.
 */
function withLineName(state: JourneyState): JourneyState {
  const leg = state.leg;
  if (!leg || typeof leg.route.shortName === 'string') return state;
  return { ...state, leg: { ...leg, route: { ...leg.route, shortName: '' } } };
}

function withLineNames(journey: ActiveJourney): ActiveJourney {
  const legs = journey.itinerary.legs.map((leg) => (
    leg.type === 'transit' && typeof leg.route.shortName !== 'string'
      ? { ...leg, route: { ...leg.route, shortName: '' } }
      : leg
  ));
  return { ...journey, itinerary: { ...journey.itinerary, legs } };
}

/**
 * Subscribes to the rider acknowledging the get-off alert from outside the
 * app, or returns null where nothing can emit it.
 *
 * Null rather than a dummy subscription so a caller cannot quietly believe it
 * is listening where there is no module.
 */
export function addAcknowledgeAlightListener(listener: () => void): EventSubscription | null {
  return native?.addListener('onAcknowledgeAlight', listener) ?? null;
}

/** Whether an OS-level surface is actually being drawn. The settings screen
 *  reads this to explain its absence rather than offering switches that
 *  silently do nothing. */
export const liveSurfaceAvailable = native !== null;
