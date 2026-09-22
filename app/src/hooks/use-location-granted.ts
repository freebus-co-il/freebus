import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Whether the rider has already let the app see where they are -- read, never
 * asked. For the maps' own location dot: a map is not a moment to ask, and on
 * Android even asking an app that already has permission opens a system
 * activity over it, which comes back as a return to the foreground (build 6
 * looped on exactly that until Android tore the activity down).
 *
 * Read again on every return to the foreground, so a permission granted from
 * the search screen or the phone's settings shows up on a map that was already
 * open.
 */
export function useLocationGranted(): boolean {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      Location.getForegroundPermissionsAsync()
        .then((permission) => {
          if (!cancelled) setGranted(permission.status === 'granted');
        })
        .catch(() => {
          // No location module here (web) -- no dot, which is the right answer.
        });
    };

    read();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') read();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return granted;
}
