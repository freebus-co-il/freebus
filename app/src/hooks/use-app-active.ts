import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

function subscribe(onChange: () => void): () => void {
  const subscription = AppState.addEventListener('change', onChange);
  return () => subscription.remove();
}

/**
 * `background` and `inactive` both count as away. `inactive` is iOS's brief
 * transitional state (the app switcher, an incoming call, a system dialog);
 * treating it as active would keep polling through exactly the moments the
 * phone is trying to settle.
 */
function isActive(): boolean {
  return AppState.currentState === 'active';
}

/**
 * Whether the app is in the foreground.
 *
 * React Query's `refetchInterval` keeps firing on React Native no matter what
 * the app is doing: its `focusManager` decides focus from `document`, which
 * does not exist here, so it assumes focused forever and a 20-second poll
 * happily runs all night in the rider's pocket. Gating a query's `enabled` on
 * this is the per-query fix -- deliberately not a global `focusManager`
 * binding, which would silently change refetch behaviour for every query in
 * the app.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: `AppState` IS an
 * external store, and reading it through one means there is no window between
 * first render and the subscription landing in which this reports a value it
 * never re-checks. The snapshot is a boolean, so React's own identity
 * comparison settles immediately.
 */
export function useAppActive(): boolean {
  // Third argument is the server snapshot, for the web build: `AppState` reads
  // the same either side of hydration, so the same function serves both.
  return useSyncExternalStore(subscribe, isActive, isActive);
}
