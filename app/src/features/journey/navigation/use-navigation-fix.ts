import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { useLocationGranted } from '@/hooks/use-location-granted';

import type { RiderPosition } from '../types';

/**
 * Close enough together for a map that follows a walker to glide rather than
 * jump. The journey's own watch reports every 20 m, which is right for counting
 * stops and far too coarse for turn-by-turn -- 20 m is a whole corner.
 */
const WALK_WATCH: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  distanceInterval: 3,
  timeInterval: 1000,
};

/**
 * A precise, frequent fix for walking guidance, only while `enabled` -- the
 * walking leg on screen, with the app in front. Kept apart from the journey's
 * own position on purpose: that one re-renders the whole app on every update,
 * and a fix every few metres would do that every couple of seconds for the
 * length of every walk. Null while off, and where location was never granted.
 */
export function useNavigationFix(enabled: boolean): RiderPosition | null {
  const granted = useLocationGranted();
  const [fix, setFix] = useState<RiderPosition | null>(null);

  useEffect(() => {
    if (!enabled || !granted) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    Location.watchPositionAsync(WALK_WATCH, (location) => {
      setFix({
        lat: location.coords.latitude,
        lon: location.coords.longitude,
        accuracyMeters: location.coords.accuracy ?? Number.POSITIVE_INFINITY,
        at: new Date(location.timestamp).toISOString(),
      });
    })
      .then((next) => {
        if (cancelled) next.remove();
        else subscription = next;
      })
      .catch(() => {
        // Location off at the OS level: guidance falls back to the journey's own fix.
      });
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled, granted]);

  return enabled ? fix : null;
}
