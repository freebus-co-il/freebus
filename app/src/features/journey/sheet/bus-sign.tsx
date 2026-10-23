import { StyleSheet, View } from 'react-native';

import type { TransitLeg } from '@/api/types';
import { Radius, Space, Text, useColors } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';

/**
 * The line as the bus itself shows it: number and destination in amber on
 * black, like the dot-matrix sign over the windscreen. The rider at the stop
 * is matching this against every bus that pulls in, so it is drawn to look
 * like the thing they are matching it against.
 */
export function BusSign({ route, headsign }: Pick<TransitLeg, 'route' | 'headsign'>) {
  const colors = useColors();
  return (
    <View
      style={[styles.sign, { backgroundColor: colors.busSignPanel }]}
      accessibilityRole="text"
      accessibilityLabel={`${route.shortName} ${formatHeadsign(headsign)}`}
    >
      <Text variant="largeTitle" emphasized numeric color="busSign" numberOfLines={1}>
        {route.shortName}
      </Text>
      <Text variant="headline" color="busSign" numberOfLines={2} style={styles.headsign}>
        {formatHeadsign(headsign)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sign: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderRadius: Radius.md,
  },
  headsign: {
    flex: 1,
  },
});
