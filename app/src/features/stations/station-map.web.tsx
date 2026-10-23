import { useTranslation } from 'react-i18next';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Surface, Text } from '@/design-system';
import type { StationKind } from '@/components/station-icon';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';

import type { StopDot } from './route-stops';

export type StationMapProps = {
  center: { latitude: number; longitude: number } | null;
  title?: string;
  kind?: StationKind;
  vehicles?: readonly VehicleMarker[];
  onVehiclePress?: (tripId: string) => void;
  edgePadding?: EdgePadding;
  // Accepted to match the native signature; web has no map to draw them on.
  route?: {
    coordinates: readonly { latitude: number; longitude: number }[];
    color: string;
    dashed: boolean;
    credit?: 'osm' | null;
  } | null;
  stops?: readonly StopDot[];
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
    <Surface level="surfaceNested" style={[styles.placeholder, style]}>
      <Text variant="subheadline" color="textSecondary">
        {t('results.mapWebUnavailable')}
      </Text>
    </Surface>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
