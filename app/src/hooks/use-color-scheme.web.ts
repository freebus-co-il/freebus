import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

import { usePreferences } from '@/features/preferences/preferences-context';

/** Never fires: whether hydration has happened changes exactly once, and React
 *  already re-renders for that. */
const subscribe = () => () => {};

/**
 * As `use-color-scheme.ts`, plus the hydration dance static web rendering
 * needs: the server pass has no device scheme to read, so the first client
 * render must match it before switching to the real value.
 *
 * `useSyncExternalStore` rather than the usual `setHasHydrated(true)` in an
 * effect. It says the same thing -- server snapshot false, client snapshot
 * true, React swapping between them once hydration completes -- but it says it
 * as a render-time read instead of a state write, which is what `reactCompiler`
 * (and `react-hooks/set-state-in-effect`) is right to reject: an effect that
 * exists only to set state is a re-render the compiler cannot see the reason
 * for.
 *
 * An explicit override is safe to honour immediately -- it comes from the
 * preferences store rather than the device, so it cannot differ between the
 * server pass and the client.
 */
export function useColorScheme() {
  const { themePreference } = usePreferences();
  const hasHydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const deviceScheme = useRNColorScheme();

  if (themePreference !== 'device') return themePreference;
  if (hasHydrated) return deviceScheme;
  return 'light';
}
