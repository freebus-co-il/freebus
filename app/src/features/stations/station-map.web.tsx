import { useTranslation } from 'react-i18next';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';

export type StationMapProps = {
  center: { latitude: number; longitude: number } | null;
  title?: string;
  kind?: 'bus' | 'train';
  vehicles?: readonly VehicleMarker[];
  onVehiclePress?: (tripId: string) => void;
  edgePadding?: EdgePadding;
  route?: { coordinates: readonly { latitude: number; longitude: number }[]; color: string; dashed: boolean } | null;
  style?: StyleProp<ViewStyle>;
};

/**
 * The web stand-in for `StationMap`, the same one `LineMap` has:
 * `react-native-maps` has no web implementation, so without this the Stations
 * tab would not bundle for web at all. It borrows `results.mapWebUnavailable`
 * rather than adding a second string that says the identical thing about the
 * identical missing library.
 */
export function StationMap({ center, style }: StationMapProps) {
  const { t } = useTranslation();

  // No centre, no box: a placeholder for a map that would have been empty
  // anyway is just an apology for nothing.
  if (center === null) return null;

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
