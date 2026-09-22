import { useTranslation } from 'react-i18next';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';

export type LatLng = { latitude: number; longitude: number };

/** A plain stop pin: the station a page is about, or the rider's own stop. */
export type MapPin = { key: string; latitude: number; longitude: number; title?: string };

export type LineMapProps = {
  // Accepted to match the native signature. Web draws no real map, so the
  // path and its colour have nothing to render into -- the path's LENGTH
  // still decides whether the placeholder is worth showing at all.
  coordinates: LatLng[];
  color: string;
  dashed?: boolean;
  vehicles?: readonly VehicleMarker[];
  onVehiclePress?: (tripId: string) => void;
  pins?: readonly MapPin[];
  edgePadding?: EdgePadding;
  style?: StyleProp<ViewStyle>;
};

/**
 * The web stand-in for `LineMap`, the same one `TripMap` has: `react-native-maps`
 * has no web implementation, so without this the Lines tab would not bundle for
 * web at all. It borrows `results.mapWebUnavailable` rather than adding a second
 * string that says the identical thing about the identical missing library.
 */
export function LineMap({ coordinates, style }: LineMapProps) {
  const { t } = useTranslation();

  // Matches native exactly: no path, no box. A placeholder for a map that
  // would have been empty anyway is just an apology for nothing.
  if (coordinates.length < 2) return null;

  return (
    <ThemedView type="surface" style={[styles.placeholder, style]}>
      <ThemedText type="small" themeColor="textSecondary">
        {t('results.mapWebUnavailable')}
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
