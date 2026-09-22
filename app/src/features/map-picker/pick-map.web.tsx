import { useTranslation } from 'react-i18next';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import type { MapStop } from '@/api/types';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

import type { MapRegion } from './map-tiles';

export type PickMapProps = {
  initialCenter: { lat: number; lon: number };
  stations: readonly MapStop[];
  onMoveStart: () => void;
  onMoveEnd: (region: MapRegion) => void;
  legalLabelBottomInset?: number;
  onCenterPoint?: (point: { x: number; y: number }) => void;
  style?: StyleProp<ViewStyle>;
};

export const INITIAL_DELTA = 0.008;

/** The web stand-in, like `StationMap`'s: `react-native-maps` has no web
 *  implementation. The entry buttons are hidden on web, so this only shows
 *  for a typed URL. */
export function PickMap({ style }: PickMapProps) {
  const { t } = useTranslation();
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
