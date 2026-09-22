import { useTranslation } from 'react-i18next';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import type { Itinerary } from '@/api/types';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export type MapEndpoint = { lat: number; lon: number };

export type TripMapProps = {
  itinerary: Itinerary | null;
  // Accepted to match the native signature. Web draws no real map, so the
  // endpoint pins native falls back to have nothing to render into -- their
  // presence still decides whether the placeholder is worth showing at all.
  origin?: MapEndpoint | null;
  destination?: MapEndpoint | null;
  style?: StyleProp<ViewStyle>;
  /** Web draws no route to frame, but the top inset still says how much of
   *  this box the caller covers with its own chrome -- which is exactly where
   *  the placeholder's text must not go. */
  edgePadding?: { top: number; right: number; bottom: number; left: number };
};

const DEFAULT_TOP_INSET = 160;

export function TripMap({
  itinerary, origin = null, destination = null, style, edgePadding,
}: TripMapProps) {
  const { t } = useTranslation();

  if (!itinerary && origin === null && destination === null) return null;

  return (
    <ThemedView
      type="surface"
      style={[styles.placeholder, { paddingTop: edgePadding?.top ?? DEFAULT_TOP_INSET }, style]}
    >
      <ThemedText type="small" themeColor="textSecondary">
        {t('results.mapWebUnavailable')}
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  // The real map (native) fills whatever box it is given -- the whole screen
  // behind the results sheet, or the backdrop of a card -- and in both cases
  // the caller floats its own opaque content over part of it. This
  // placeholder stands in for that map on web, so its text has to sit in the
  // band that's actually left visible rather than dead-centered on a box
  // whose bottom half is covered. `edgePadding.top` is the caller's own
  // measurement of where that band starts; the fallback is the results
  // screen's typical top bar, for callers that pass no padding at all.
  placeholder: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
});
