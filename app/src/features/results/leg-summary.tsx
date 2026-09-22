import { IconWalk } from '@tabler/icons-react-native';
import { StyleSheet, View } from 'react-native';

import type { Leg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDurationMinutes } from '@/lib/format';



export type LegSummaryProps = {
  leg: Leg;
};


/** One glyph + duration in the card's at-a-glance leg timeline -- e.g. a
 *  walk icon and "2 min", or a route badge and "20 min". Headsign, stop
 *  count, and geometry-fallback text have no room in a compact timeline;
 *  nothing else in the card surfaces that detail either, so it's a real
 *  trade-off, not an oversight. */
export function LegSummary({ leg }: LegSummaryProps) {
  const theme = useTheme();

  if (leg.type === 'walk') {
    return (
      <View style={styles.item}>
        <IconWalk size={16} color={theme.textSecondary} />
        <ThemedText type="small" themeColor="textSecondary">
          {formatDurationMinutes(leg.durationSeconds)}
        </ThemedText>
      </View>
    );
  }

  const durationSeconds = (new Date(leg.to.arrivalTime).getTime() - new Date(leg.from.departureTime).getTime()) / 1000;

  return (
    <View style={styles.item}>
      <LineBadge route={leg.route} />
      <ThemedText type="small" themeColor="textSecondary">
        {formatDurationMinutes(durationSeconds)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
});
