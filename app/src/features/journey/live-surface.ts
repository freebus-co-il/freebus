import { NativeModule, requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { TFunction } from 'i18next';

import type { JourneyCopy } from './journey-copy';
import type { JourneyRail } from './journey-rail';
import type { ActiveJourney, JourneyState } from './types';

export type LiveSurfaceAlert = { title: string; body: string; sound: boolean; vibrate: boolean };

/**
 * The words a live surface prints, resolved on this side of the bridge.
 *
 * A `JourneyState` carries facts and no prose, so a renderer handed only the
 * state has to invent its own -- which is how the Android module ended up with
 * a second copy of the `journey.*` keys in `strings.xml`, one per locale, free
 * to drift from the JSON the rest of the app reads. `react-i18next` lives here
 * and only here; the surfaces are handed the finished sentences.
 *
 * `hero` is fed from `JourneyCopy.heroStatic`, NOT from its `hero`: these
 * surfaces render their own countdown from a date range the OS animates, so a
 * sentence with a minute baked into it would both cost an update a minute and
 * freeze mid-count the moment the app suspends. `action` is dropped because
 * neither OS surface has anywhere to put a control that re-plans.
 */
export type JourneySurfaceCopy = {
  hero: string;
  supporting: string | null;
  accent: string;
  /**
   * "Get off" in one word, for the slot beside the camera.
   *
   * The Dynamic Island's compact trailing element is about 46pt wide -- room
   * for a clock or a glyph, and nothing like room for the `alight-soon` hero.
   * It printed a hardcoded "NOW", which is the one thing this whole contract
   * exists to prevent: an English word, on a Hebrew phone, on the surface the
   * rider is most likely to be reading at a run. So it crosses the bridge
   * translated like every other word does.
   */
  alightNow: string;
  /** "Live" / "Scheduled" beside a departure countdown, already translated;
   *  empty when there is nothing to label (see `liveLabelFor`). */
  liveLabel: string;
};

/** Narrows the full in-app copy to what an OS surface should print. The one
 *  place `heroStatic` is chosen over `hero`, so no caller has to remember. */
export function surfaceCopy(copy: JourneyCopy, t: TFunction, liveLabel = ''): JourneySurfaceCopy {
  return {
    hero: copy.heroStatic,
    supporting: copy.supporting,
    accent: copy.accent,
    // Phase-independent: the widget reads it only while alighting, and paying
    // for one lookup per update is cheaper than threading a phase in here.
    alightNow: t('journey.phase.alightSoonCompact'),
    liveLabel,
  };
}

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
 * Null on web, and on any build whose native module is missing -- Expo Go, or
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
    await native?.start(journey, state, rail, copy);
  },
  async update(state, copy, alert) {
    await native?.update(state, copy, alert);
  },
  async stop() {
    await native?.stop();
  },
};

/**
 * Subscribes to the rider acknowledging the get-off alert from outside the
 * app, or returns null where nothing can emit it.
 *
 * Null rather than a dummy subscription so a caller cannot quietly believe it
 * is listening on web.
 */
export function addAcknowledgeAlightListener(listener: () => void): EventSubscription | null {
  return native?.addListener('onAcknowledgeAlight', listener) ?? null;
}

/** Whether an OS-level surface is actually being drawn. The settings screen
 *  reads this to explain its absence rather than offering switches that
 *  silently do nothing. */
export const liveSurfaceAvailable = native !== null;
