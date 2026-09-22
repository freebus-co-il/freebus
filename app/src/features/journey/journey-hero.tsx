import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { journeyCopy } from './journey-copy';
import type { JourneyState } from './types';

/**
 * What the rider is doing, in one line they can read from arm's length, with
 * one line of detail under it.
 *
 * Takes the itinerary as well as the state because three of the eight phases
 * are walks, and the machine carries no leg on those -- the stop a rider is
 * walking to, and how long it takes, live only in the plan.
 */
export function JourneyHero({
  state,
  itinerary,
  /** What the rider called their destination. Optional because it is a
   *  nicety rather than a fact the copy depends on -- `journeyCopy` falls
   *  back to "to your destination" without it. */
  destinationLabel = '',
}: {
  state: JourneyState;
  itinerary: Itinerary;
  destinationLabel?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();

  const lines = journeyCopy(state, itinerary, destinationLabel, t, { end: theme.text, alert: theme.danger });

  return (
    <View style={styles.container}>
      {/* The route's colour, carried without repeating the line number the
          hero has already said. The same colour as this leg's segment on the
          rail below and its polyline on the map above. */}
      <View style={[styles.accent, { backgroundColor: lines.accent }]} />
      <View style={styles.lines}>
        <ThemedText type="subtitle" numberOfLines={2}>
          {lines.hero}
        </ThemedText>
        {lines.supporting !== null && (
          <ThemedText type="default" themeColor="textSecondary">
            {lines.supporting}
          </ThemedText>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.three,
  },
  accent: {
    width: 4,
    borderRadius: 2,
  },
  lines: {
    flex: 1,
    gap: Spacing.one,
  },
});
