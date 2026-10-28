import * as Location from 'expo-location';
import { useCallback, useRef, useState } from 'react';

import type { SelectedPlace } from '@/lib/place';

import {
  resolveCurrentPosition,
  type Coords,
  type CurrentLocationErrorMessage,
  type LocationSource,
} from './resolve-current-position';

export type { CurrentLocationErrorMessage };

/** How long a fresh fix gets before the rider is offered a starting point
 *  instead. `getCurrentPositionAsync` has no deadline of its own: where no fix
 *  is coming -- an emulator with no provider, a basement, location switched
 *  off at the OS level -- it simply never settles, and every screen waiting on
 *  the origin waits forever with it. */
const FIX_TIMEOUT_MS = 5_000;

/** A cached position older or vaguer than this is not shown while the fresh
 *  fix is on its way. Five minutes on foot or on a bus is rarely out of reach
 *  of the same stops, and the fresh fix replaces it anyway if it moved. */
const LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;
const LAST_KNOWN_ACCURACY_METERS = 200;

type CurrentLocationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: CurrentLocationErrorMessage }
  | { status: 'success'; place: SelectedPlace };

const deviceLocation: LocationSource = {
  requestPermission: async () =>
    (await Location.requestForegroundPermissionsAsync()).status === 'granted',
  hasPermission: async () =>
    (await Location.getForegroundPermissionsAsync()).status === 'granted',
  lastKnown: async () => {
    const position = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
      requiredAccuracy: LAST_KNOWN_ACCURACY_METERS,
    });
    return position && { lat: position.coords.latitude, lon: position.coords.longitude };
  },
  current: async (interactive) => {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      mayShowUserSettingsDialog: interactive,
    });
    return { lat: position.coords.latitude, lon: position.coords.longitude };
  },
};

/**
 * `label` is never shown -- origin isn't displayed in any field -- but
 * `SelectedPlace` requires one, so it's a fixed "Current location" string
 * passed in by the caller (this hook has no access to `useTranslation()`).
 *
 * `request` may prompt: for permission, and on Android for turning location
 * on. It is for a launch and a rider's own tap. `refresh` never shows anything
 * and is for the app coming back to the foreground -- on Android either
 * prompt is a system activity over the app, so closing it IS a return to the
 * foreground, and a refresh that prompted would prompt again forever (build 6
 * did, ~12 times a second, until Android tore the activity down).
 *
 * With a fix already on screen both stay `success` throughout rather than
 * dropping back to `loading`, so neither blanks what depends on it.
 */
export function useCurrentLocation(label: string) {
  const [state, setState] = useState<CurrentLocationState>({ status: 'idle' });
  const shown = useRef<Coords | null>(null);
  // Only the latest request may write. An earlier one still waiting on its
  // fix must not land after -- and contradict -- the answer that superseded it.
  const generation = useRef(0);

  const resolve = useCallback(async (interactive: boolean) => {
    const run = ++generation.current;
    if (shown.current === null) setState({ status: 'loading' });
    await resolveCurrentPosition(deviceLocation, {
      timeoutMs: FIX_TIMEOUT_MS,
      previous: shown.current,
      interactive,
      onUpdate: (update) => {
        if (run !== generation.current) return;
        if (update.status === 'error') {
          shown.current = null;
          setState(update);
          return;
        }
        shown.current = update.coords;
        setState({ status: 'success', place: { kind: 'coordinate', ...update.coords, label } });
      },
    });
  }, [label]);

  const request = useCallback(() => resolve(true), [resolve]);
  const refresh = useCallback(() => resolve(false), [resolve]);

  return { state, request, refresh };
}
