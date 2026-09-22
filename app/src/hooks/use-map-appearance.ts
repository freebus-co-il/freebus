import { Platform } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { androidMapStyle, type MapStyleRule } from '@/lib/map-style';

export type MapAppearance = {
  /** Handed straight to `MapView`'s `userInterfaceStyle`. Never `'system'`:
   *  following the system is exactly the behaviour this exists to override. */
  userInterfaceStyle: 'light' | 'dark';
  /** Handed to the `MapView` as its `key`. See below -- `undefined` (no
   *  remount) everywhere the prop is live. */
  remountKey: string | undefined;
  /** Handed straight to `MapView`'s `customMapStyle`. Every map MUST take it:
   *  on Android a map without a real style draws a blank basemap on updated
   *  devices (see `androidMapStyle`). Apple Maps ignores the prop. */
  customMapStyle: MapStyleRule[];
};

/**
 * How a native basemap should be painted: the app's own colour scheme, so a
 * rider who forces light mode on a dark-mode phone gets a light map too.
 *
 * Left alone, neither platform's map asks the app anything -- Apple Maps reads
 * the view's trait collection and Google Maps defaults to
 * `MapColorScheme.FOLLOW_SYSTEM`, both of which follow the DEVICE. The theme
 * override lives in the preferences store and never reaches the OS, so
 * without this hook the map would be the one surface in the app that
 * ignored it.
 *
 * On Android the look itself comes from `customMapStyle`, which every map has
 * to carry anyway. `monochrome` drains its colour for a map that text sits on.
 *
 * The remount key is Android's half. `react-native-maps` applies
 * `userInterfaceStyle` there through `GoogleMapOptions` when the map is
 * constructed and its prop setter is a documented no-op (`MapViewManager`:
 * "do nothing (initialProp)"), so a map already on screen keeps whatever
 * scheme it was born with. Keying it on the scheme rebuilds the map when --
 * and only when -- the rider actually changes the setting. iOS updates the
 * override in place, so it gets no key and keeps its camera.
 */
export function useMapAppearance({ monochrome = false }: { monochrome?: boolean } = {}): MapAppearance {
  const scheme = useColorScheme();
  const userInterfaceStyle = scheme === 'dark' ? 'dark' : 'light';

  return {
    userInterfaceStyle,
    remountKey: Platform.OS === 'android' ? userInterfaceStyle : undefined,
    customMapStyle: androidMapStyle(userInterfaceStyle, monochrome),
  };
}
