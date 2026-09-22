import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

/** The dotted stretch of spine standing in for the folded stops. */
const DOT_COUNT = 3;
const DOT_SIZE = 4;

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

  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <View style={styles.spineColumn}>
        {Array.from({ length: DOT_COUNT }, (_, index) => (
          <View key={index} style={[styles.dot, { backgroundColor: color }]} />
        ))}
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
        {t('line.previousStops', { count })}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingEnd: Spacing.three,
    minHeight: 44,
  },
  // Same width as `StopSpineRow`'s spine column, so the dots sit on its line.
  spineColumn: {
    width: Spacing.six,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    opacity: 0.4,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
  label: {
    flex: 1,
  },
});
