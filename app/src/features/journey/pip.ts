import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useState } from 'react';
import { AppRegistry, Platform } from 'react-native';

import { useAppActive } from '@/hooks/use-app-active';

import type { RiderPosition } from './types';

/** A fix from the native fused provider while in PiP. `accuracyMeters` is
 *  absent when the fix did not state one. */
type NativePosition = { lat: number; lon: number; accuracyMeters?: number; at: string };

type PipEvents = {
  onPipModeChanged: (event: { inPip: boolean }) => void;
  onJourneyPosition: (event: NativePosition) => void;
};
declare class PipEmitter extends NativeModule<PipEvents> {}

/** Optional members: a binary built before PiP landed has the module but not
 *  these, and must degrade to "no PiP" rather than throw. */
type PipNative = PipEmitter & {
  isPipAvailable?: () => boolean;
  isInPip?: () => boolean;
  setPip?: (armed: boolean, acknowledge: boolean) => Promise<void>;
  leavePip?: () => Promise<void>;
};

/** Android only. iOS reserves PiP for video; the Live Activity covers it there. */
const native = Platform.OS === 'android' ? requireOptionalNativeModule<PipNative>('LiveJourney') : null;

/** Must match `JourneyPipKeepAlive.TASK_KEY` on the native side. */
const PIP_KEEP_ALIVE_TASK = 'FreebusJourneyPipKeepAlive';

/**
 * The JS half of the PiP keep-alive.
 *
 * A PiP activity is paused while visible, and React Native stops JS timers on
 * pause unless a headless task is running. The native module starts this task
 * on entering PiP; it does nothing but wait for PiP to end, and simply being
 * pending is what keeps the journey clock, the live polls and the arrival
 * timer running in the window (see `JourneyPipKeepAlive.kt`). Native finishes
 * the task itself on leaving PiP; resolving here too only tidies the promise.
 *
 * Registered at module scope because the task can be started before any
 * component has mounted a listener, and registered only where the native
 * module exists to start it.
 */
let releaseKeepAlive: (() => void) | null = null;
if (native) {
  AppRegistry.registerHeadlessTask(PIP_KEEP_ALIVE_TASK, () => () =>
    new Promise<void>((resolve) => {
      releaseKeepAlive?.();
      releaseKeepAlive = resolve;
    }),
  );
  native.addListener('onPipModeChanged', (event) => {
    if (event.inPip) return;
    releaseKeepAlive?.();
    releaseKeepAlive = null;
  });
}

/**
 * Whether SOME journey currently wants PiP armed, tracked here rather than
 * trusted to whoever calls `leave()`.
 *
 * The journey-arrival flow schedules a `leave()` a few seconds after the
 * final state is pushed, so the rider has time to read "You're here" before
 * the window puts itself away -- but that timer is not cancelled if a new
 * journey starts in the meantime, because the effect that would own its
 * cleanup belongs to the journey that just ended. Set BEFORE the native call
 * is awaited, so a `set(true, ...)` from a freshly-started journey is visible
 * to a `leave()` call already in flight for the old one.
 */
let armed = false;

export const pip = {
  available(): boolean {
    return native?.isPipAvailable?.() ?? false;
  },
  async set(nextArmed: boolean, acknowledge: boolean): Promise<void> {
    armed = nextArmed;
    await native?.setPip?.(nextArmed, acknowledge);
  },
  async leave(): Promise<void> {
    // A leave requested for the journey that just finished must never close
    // the window of one armed since -- which is exactly what a stray,
    // uncancelled linger timer from the old journey would do without this
    // guard.
    if (armed) return;
    await native?.leavePip?.();
  },
};

/** Whether the activity is currently the PiP window. */
export function usePip(): { inPip: boolean } {
  const [inPip, setInPip] = useState(() => native?.isInPip?.() ?? false);
  useEffect(() => {
    const subscription = native?.addListener('onPipModeChanged', (event) => setInPip(event.inPip));
    return () => subscription?.remove();
  }, []);
  return { inPip };
}

/**
 * The rider's fixes while in PiP, from the native fused provider.
 *
 * expo-location stops its watches when the activity pauses, which a PiP
 * activity is, so the in-app watch goes silent in the window. The native module
 * feeds positions for exactly as long as PiP lasts, and only with location
 * permission already granted; outside PiP this never fires.
 */
export function useJourneyPipPosition(onFix: (position: RiderPosition) => void): void {
  useEffect(() => {
    const subscription = native?.addListener('onJourneyPosition', (event) =>
      onFix({
        lat: event.lat,
        lon: event.lon,
        // A fix with no stated accuracy is treated as the worst one the
        // machine will still act on rather than as a perfect one.
        accuracyMeters: event.accuracyMeters ?? Number.POSITIVE_INFINITY,
        at: event.at,
      }),
    );
    return () => subscription?.remove();
  }, [onFix]);
}

/**
 * Whether the rider can see the journey: the app is in front, or it is the
 * PiP window. The PiP half is explicit because React Native reports a PiP
 * activity as backgrounded -- it is paused while visible -- and everything
 * gated on "the app is active" would freeze in the window the rider is
 * looking at.
 */
export function useJourneyVisible(): boolean {
  const appActive = useAppActive();
  const { inPip } = usePip();
  return appActive || inPip;
}
