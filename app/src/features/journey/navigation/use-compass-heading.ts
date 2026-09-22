import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { useLocationGranted } from '@/hooks/use-location-granted';

import { angleBetween } from './walk-guidance';

/** A compass reading has to move this far to be worth a re-render: the needle
 *  shivers by a degree or two while the phone sits still in a hand. */
const COMPASS_STEP_DEGREES = 5;

/**
 * Which way the phone faces, in degrees clockwise from true north -- what turns
 * a walking rider's map to match the street in front of them. Null when
 * `enabled` is off, before the first reading, and where the app has not already
 * been given location (a map is never the moment to ask; see
 * `useLocationGranted`).
 */
export function useCompassHeading(enabled: boolean): number | null {
  const granted = useLocationGranted();
  const [heading, setHeading] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !granted) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    Location.watchHeadingAsync((reading) => {
      // `trueHeading` is -1 until the OS has a location to correct by.
      const value = reading.trueHeading >= 0 ? reading.trueHeading : reading.magHeading;
      if (!Number.isFinite(value) || value < 0) return;
      setHeading((current) => (current !== null && angleBetween(current, value) < COMPASS_STEP_DEGREES ? current : value));
    })
      .then((next) => {
        if (cancelled) next.remove();
        else subscription = next;
      })
      .catch(() => {
        // No compass here (web, a simulator without one): the map turns along
        // the walk's own line instead.
      });
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled, granted]);

  return enabled ? heading : null;
}
