import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Layout, Opacity, Radius, Size, Text, useColors } from '@/design-system';

import { SPINE_COLUMN_WIDTH, SPINE_WIDTH } from './stop-spine';

/** The dotted stretch of spine standing in for the folded stops: as many dots
 *  as read as "and so on", each as wide as the spine they stand in for. */
const DOT_COUNT = 3;
const DOT_SIZE = SPINE_WIDTH;

/**
 * The stops a rider no longer needs, folded into one row at the top of a
 * stop list: "12 previous stops". Tapping it unfolds them in place.
 *
 * Laid out on the same column as `StopSpineRow` -- the spine runs on through
 * it as a dotted, dimmed stretch -- so the list still reads as one line that
 * simply started further back.
 */
export function PreviousStopsRow({ count, color, onPress }: { count: number; color: string; onPress: () => void }) {
  const { t } = useTranslation();
  const colors = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      android_ripple={{ color: colors.fillPressed }}
      style={({ pressed }) => [styles.row, pressed && Platform.OS === 'ios' && { backgroundColor: colors.fillPressed }]}
    >
      <View style={styles.spineColumn}>
        {Array.from({ length: DOT_COUNT }, (_, index) => (
          <View key={index} style={[styles.dot, { backgroundColor: color }]} />
        ))}
      </View>
      <Text variant="subheadline" color="textSecondary" style={styles.label}>
        {t('line.previousStops', { count })}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingEnd: Layout.rowPaddingH,
    minHeight: Size.row.dense,
  },
  // Same width as `StopSpineRow`'s spine column, so the dots sit on its line.
  // Dimmed like the stops it folds away.
  spineColumn: {
    width: SPINE_COLUMN_WIDTH,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    opacity: Opacity.done,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: Radius.full,
  },
  label: {
    flex: 1,
  },
});
