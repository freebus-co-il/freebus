import { IconFlagFilled } from '@tabler/icons-react-native';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

import type { JourneyRail } from './journey-rail';

const BAR_HEIGHT = 8;
const POINT_SIZE = 10;
const FLAG_SIZE = 20;
const TRACKER_SIZE = 18;
/** Thick enough that the tracker still reads as a separate object when it is
 *  sitting on top of a segment its own colour. */
const TRACKER_RING = 3;

/** Half of this hangs outside the rail at each end, where the origin dot and
 *  the destination flag are centred on fractions 0 and 1. Padding the track by
 *  it keeps every marker inside the view's own bounds, which is the one way to
 *  be sure nothing is clipped on Android. */
const WIDEST_MARKER = Math.max(POINT_SIZE, FLAG_SIZE, TRACKER_SIZE);

/**
 * Centres a marker on a fraction of the rail.
 *
 * Logical inline properties rather than `left`/`marginLeft`, because RTL is
 * first-class here: `insetInlineStart` measures from the rail's own start,
 * which is the right-hand edge in Hebrew -- the same edge `flexDirection:
 * 'row'` starts the segments from, so the markers and the colours they sit on
 * stay in agreement without either side knowing which way round it is.
 */
function markerAt(fraction: number, size: number): ViewStyle {
  const clamped = Math.min(1, Math.max(0, fraction));
  return {
    position: 'absolute',
    insetInlineStart: `${clamped * 100}%`,
    top: '50%',
    marginInlineStart: -size / 2,
    marginTop: -size / 2,
  };
}

/**
 * The journey as one horizontal bar: a coloured segment per leg, a diamond at
 * every change of vehicle, the two endpoints pinned to the edges, and a
 * tracker showing how far along the rider is.
 *
 * Drawn from `buildJourneyRail`'s output and nothing else, because the SwiftUI
 * widget and Android's `ProgressStyle` draw the same model -- so a rider
 * glancing at the Lock Screen and then opening the app sees one picture, not
 * two diagrams of the same trip that happen to disagree.
 */
export function JourneyRailView({ rail, progress }: { rail: JourneyRail; progress: number }) {
  const theme = useTheme();

  // A rail with no duration cannot be divided into fractions at all. Every
  // marker collapses onto the start, which is honest: nothing has elapsed.
  const fractionOf = (seconds: number) => (rail.totalSeconds > 0 ? seconds / rail.totalSeconds : 0);

  return (
    <View
      style={styles.container}
      // Decorative. Everything it draws -- where the transfers fall, how far
      // along the rider is -- the hero line and the step list below say in
      // words, so a screen reader announcing a row of unlabelled coloured
      // views would only be in the way.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.track}>
        {/* The muted fill shows through wherever the segments do not reach,
            which is what a zero-duration itinerary leaves behind. */}
        <View style={[styles.bar, { backgroundColor: theme.borderMuted }]}>
          {rail.segments.map((segment) => (
            <View key={segment.legIndex} style={{ flex: segment.seconds, backgroundColor: segment.color }} />
          ))}
        </View>

        <View style={[styles.point, { backgroundColor: theme.text }, markerAt(0, POINT_SIZE)]} />

        {rail.points.map((point, index) => (
          <View
            key={`${point.atSeconds}-${index}`}
            style={[
              styles.diamond,
              { backgroundColor: theme.text, borderColor: theme.background },
              markerAt(fractionOf(point.atSeconds), POINT_SIZE),
            ]}
          />
        ))}

        <View style={[styles.flag, { backgroundColor: theme.text }, markerAt(1, FLAG_SIZE)]}>
          <IconFlagFilled size={12} color={theme.background} />
        </View>

        {/* Last, so it rides over the endpoints and the transfers rather than
            disappearing behind whichever one it happens to be passing. */}
        <View
          style={[
            styles.tracker,
            { backgroundColor: theme.text, borderColor: theme.background },
            markerAt(progress, TRACKER_SIZE),
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: WIDEST_MARKER / 2,
  },
  track: {
    height: WIDEST_MARKER,
    justifyContent: 'center',
  },
  bar: {
    flexDirection: 'row',
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    // Clips the first and last segment to the rounded ends, so the bar reads
    // as one object rather than as coloured blocks with square corners.
    overflow: 'hidden',
  },
  point: {
    width: POINT_SIZE,
    height: POINT_SIZE,
    borderRadius: POINT_SIZE / 2,
  },
  diamond: {
    width: POINT_SIZE,
    height: POINT_SIZE,
    borderWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  flag: {
    width: FLAG_SIZE,
    height: FLAG_SIZE,
    borderRadius: FLAG_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tracker: {
    width: TRACKER_SIZE,
    height: TRACKER_SIZE,
    borderRadius: TRACKER_SIZE / 2,
    borderWidth: TRACKER_RING,
  },
});
