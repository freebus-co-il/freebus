import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Border, Layout, MapStyle, Opacity, Radius, Size, Space, Text, useColors } from '@/design-system';
import { formatClockTime } from '@/lib/format';

/** The coloured spine's width, and the diameter of the dots that sit on it.
 *  Sized so a dot reads as a bead ON the line rather than a circle beside it.
 *  Geometry of the drawing itself, not spacing. */
export const SPINE_WIDTH = 4;
const DOT_SIZE = 10;
const BOARDING_DOT_SIZE = 16;

/** The spine column: twice the distance to the middle of a row's leading
 *  slot, so the spine runs straight down under the line badge of the row above
 *  it (a departure on the board, a line's header). Shared with
 *  `PreviousStopsRow`, whose dots must sit on the same line. */
export const SPINE_COLUMN_WIDTH = (Layout.rowPaddingH + Size.leadingTile / 2) * 2;

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
  const colors = useColors();
  // A stop behind the rider's own: still on the line, no longer their part of it.
  const done = passed && !boarding;

  const row = (
    <>
      <View style={styles.spineColumn}>
        <View
          style={[
            styles.spineSegment,
            { backgroundColor: first ? 'transparent' : color },
            passed && !first && styles.spineSpent,
          ]}
        />
        {/* An ordinary stop is a hollow bead, filled with the marker ring's
            colour -- the sheet's own in both themes, the same fill the map's
            stop dots wear. The rider's stop is a bigger, solid one. */}
        <View
          style={[
            boarding ? styles.boardingDot : styles.dot,
            { backgroundColor: boarding ? color : colors.mapMarkerRing, borderColor: color },
            done && styles.done,
          ]}
        />
        <View
          style={[
            styles.spineSegment,
            { backgroundColor: last ? 'transparent' : color },
          ]}
        />
      </View>

      <View style={[styles.text, done && styles.done]}>
        <Text variant={boarding ? 'headline' : 'body'} numberOfLines={2} style={styles.stopName}>
          {stop.name}
        </Text>

        {stop.time !== null && (
          <Text variant="subheadline" emphasized={boarding} numeric>
            {formatClockTime(stop.time)}
          </Text>
        )}
      </View>
    </>
  );

  if (onPress === undefined) return <View style={styles.stopRow}>{row}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      android_ripple={{ color: colors.fillPressed }}
      style={({ pressed }) => [styles.stopRow, pressed && Platform.OS === 'ios' && { backgroundColor: colors.fillPressed }]}
    >
      {row}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingEnd: Layout.rowPaddingH,
    minHeight: Size.row.dense,
  },
  spineColumn: {
    width: SPINE_COLUMN_WIDTH,
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
    opacity: Opacity.dimmed,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: Radius.full,
    borderWidth: Border.selected,
  },
  boardingDot: {
    width: BOARDING_DOT_SIZE,
    height: BOARDING_DOT_SIZE,
    borderRadius: Radius.full,
    borderWidth: MapStyle.markerRingWidth,
  },
  done: {
    opacity: Opacity.done,
  },
  text: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  stopName: {
    flex: 1,
    paddingVertical: Space.sm,
  },
});
