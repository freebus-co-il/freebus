import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { I18nManager, StyleSheet, View } from 'react-native';

import type { Departure } from '@/api/types';
import { Space, useColors, withAlpha } from '@/design-system';

import { DepartureEntry } from './departure-entry';

/** A station's peek: how many departures a row under its name asks for.
 *  Shared by every peek (nearby, favorites) so a station that is in both
 *  asks one question and shares one cache entry. */
export const DEPARTURES_PER_STATION = 4;

/**
 * The departures for one stop, on ONE line however many there are.
 *
 * Wrapping was what made this section ragged: a stop with four buses grew
 * a second line and shoved the next station down, so a list of five stops
 * had no rhythm to scan. A clipped line keeps every row the same height,
 * and the fade says there is more rather than letting the last departure
 * end in a hard cut.
 *
 * Measured the way `LegTimeline` measures its own overflow -- the last
 * item's position against the container's width, which needs no `isRTL`
 * branch because testing both ends covers both directions.
 */
export function DepartureLine({ departures, showLive, now }: {
  departures: Departure[]; showLive: boolean; now: Date;
}) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const [tailStart, setTailStart] = useState(0);
  const [tailWidth, setTailWidth] = useState(0);

  const overflowing = width > 0 && (tailStart < -1 || tailStart + tailWidth > width + 1);
  // The row's own surface at zero alpha rather than `transparent`, which is
  // rgba(0,0,0,0) and smears grey through the middle of the ramp -- same
  // reasoning as `LegTimeline`. `surfaceGroup` because the row sits in a
  // grouped list.
  const fade = [withAlpha(colors.surfaceGroup, 0), colors.surfaceGroup] as const;

  return (
    <View
      style={styles.departureLine}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {departures.map((departure, index) => (
        <View
          key={`${departure.runId}:${departure.departureTime}`}
          style={styles.departureSlot}
          onLayout={
            index === departures.length - 1
              ? (event) => {
                setTailStart(event.nativeEvent.layout.x);
                setTailWidth(event.nativeEvent.layout.width);
              }
              : undefined
          }
        >
          <DepartureEntry departure={departure} showLive={showLive} now={now} />
        </View>
      ))}

      {overflowing && (
        <LinearGradient
          // Reversed under RTL: in Hebrew the line runs right-to-left, so
          // the hidden tail -- and the fade over it -- is at the LEFT edge.
          colors={I18nManager.isRTL ? [fade[1], fade[0]] : [fade[0], fade[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          pointerEvents="none"
          style={styles.departureFade}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // One line, clipped. `nowrap` is the point: a stop with four buses must
  // not grow a second line and shove the next station down.
  departureLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    gap: Space.lg,
    marginTop: Space.xs,
  },
  // Every departure pinned: an overflowing line pushes its tail past the
  // end edge, it never squeezes the departures to fit.
  departureSlot: {
    flexShrink: 0,
  },
  // `end`, not `right`: the hidden tail is at the writing direction's end,
  // which is the LEFT edge in Hebrew.
  departureFade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    end: 0,
    width: Space.xxxl,
  },
});
