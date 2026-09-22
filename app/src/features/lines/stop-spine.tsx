import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime } from '@/lib/format';

/** The coloured spine's width, and the diameter of the dots that sit on it.
 *  Sized so a dot reads as a bead ON the line rather than a circle beside it. */
const SPINE_WIDTH = 4;
const DOT_SIZE = 10;
const BOARDING_DOT_SIZE = 16;

export type SpineStop = {
  key: string;
  name: string;
  /** ISO-8601, or null when this surface has no times to show. */
  time: string | null;
};

type StopSpineRowProps = {
  stop: SpineStop;
  color: string;
  /** The stop the rider boards at, if this surface knows one. */
  boarding: boolean;
  passed: boolean;
  first: boolean;
  last: boolean;
  /** Given only by the line page, whose stops open their own board. The run
   *  page's stops are not navigable, so it passes nothing and the row
   *  renders as a plain View. */
  onPress?: () => void;
};

/**
 * One call on a line, threaded onto the line's own colour.
 *
 * Shared by the run page (a specific vehicle, with times) and the line page
 * (the line itself, whose times come from whichever run is selected). The
 * spine is drawn as two half-height segments rather than one full-height
 * bar so the terminal rows can drop the half that would otherwise run off
 * the end of the line -- a route that visibly starts and stops, instead of
 * a stripe that continues past its own first and last stop. That is the
 * part worth sharing: hand-copied into a second screen it would drift.
 */
export function StopSpineRow({
  stop,
  color,
  boarding,
  passed,
  first,
  last,
  onPress,
}: StopSpineRowProps) {
  const theme = useTheme();

  const row = (
    <View style={styles.stopRow}>
      <View style={styles.spineColumn}>
        <View
          style={[
            styles.spineSegment,
            { backgroundColor: first ? 'transparent' : color },
            passed && !first && styles.spineSpent,
          ]}
        />
        <View
          style={[
            boarding ? styles.boardingDot : styles.dot,
            { backgroundColor: boarding ? color : theme.background, borderColor: color },
          ]}
        />
        <View
          style={[
            styles.spineSegment,
            { backgroundColor: last ? 'transparent' : color },
          ]}
        />
      </View>

      <ThemedText
        type={boarding ? 'smallBold' : 'default'}
        numberOfLines={2}
        themeColor={passed && !boarding ? 'textSecondary' : undefined}
        style={styles.stopName}
      >
        {stop.name}
      </ThemedText>

      {stop.time !== null && (
        <ThemedText type="small" themeColor={passed && !boarding ? 'textSecondary' : undefined}>
          {formatClockTime(stop.time)}
        </ThemedText>
      )}
    </View>
  );

  if (onPress === undefined) return row;
  return <Pressable onPress={onPress}>{row}</Pressable>;
}

const styles = StyleSheet.create({
  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingEnd: Spacing.three,
    minHeight: 44,
  },
  spineColumn: {
    width: Spacing.six,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  spineSegment: {
    flex: 1,
    width: SPINE_WIDTH,
  },
  /** Dimmed, not hidden: the run really does continue back that way, it just
   *  isn't this rider's part of it. */
  spineSpent: {
    opacity: 0.3,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 2,
  },
  boardingDot: {
    width: BOARDING_DOT_SIZE,
    height: BOARDING_DOT_SIZE,
    borderRadius: BOARDING_DOT_SIZE / 2,
    borderWidth: 3,
  },
  stopName: {
    flex: 1,
    paddingVertical: Spacing.two,
  },
});
