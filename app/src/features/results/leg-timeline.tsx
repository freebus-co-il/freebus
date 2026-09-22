import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, useState } from 'react';
import { I18nManager, StyleSheet, View } from 'react-native';

import type { Leg } from '@/api/types';
import { IconForward } from '@/components/directional-icon';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { LegSummary } from './leg-summary';

/** How much of the trailing edge the fade covers. Wide enough to read as a
 *  "there's more" cue rather than a hard crop, narrow enough not to swallow
 *  a whole leg. */
const FADE_WIDTH = 40;

export type LegTimelineProps = {
  legs: Leg[];
};

/**
 * The card's at-a-glance journey strip: [walk icon] 2 min -> [route badge] 20
 * min -> [walk icon] 12 min.
 *
 * Always exactly one line, and always anchored at the START of the journey.
 * A trip with many transfers overflows the card width and is clipped behind a
 * fade at the trailing edge instead of wrapping to a second line -- every card
 * in the carousel is as tall as the tallest one, so a single many-legged trip
 * wrapping would add a whole row of empty space to every other card on screen.
 * What gets hidden is therefore the tail: the rider can always see the leg
 * they are about to walk out of the door for.
 *
 * This is a plain clipped row, not a horizontal `ScrollView`. The `ScrollView`
 * was here because it is the one container that reports its own content width
 * even when that width overflows (`onContentSizeChange`), which is how the
 * fade knew whether to show -- but a scroll view also has a scroll POSITION,
 * and which end of the content sits at offset zero under RTL differs between
 * iOS, Android and web. On the platforms that answer "the far end", the strip
 * showed the rider the last leg of the journey and hid the first. A row has no
 * offset to get wrong: Yoga lays it out from the start edge in both
 * directions, and `overflow: hidden` clips whatever runs past the end.
 *
 * Overflow is then measured from the LAST leg instead of from a content width
 * (see `overflowing` below), which needs no scroll container to observe.
 */
export function LegTimeline({ legs }: LegTimelineProps) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [tailStart, setTailStart] = useState(0);
  const [tailWidth, setTailWidth] = useState(0);

  // A child's `x` is measured from the container's LEFT edge in both layout
  // directions -- that is what Yoga computes -- so the last leg of an
  // overflowing strip runs off the right under LTR and sits at a NEGATIVE x
  // under RTL. Testing both ends covers both directions without an `isRTL`
  // branch. 1px of slack either way: sub-pixel layout rounding otherwise
  // reports a strip that exactly fits as a hair too wide, fading a timeline
  // with nothing hidden.
  const overflowing = width > 0 && (tailStart < -1 || tailStart + tailWidth > width + 1);

  // Fades to the page, not to `transparent` -- the shorthand `transparent`
  // is rgba(0,0,0,0), which reads as a dirty grey smear across the middle of
  // the ramp on a white page. `${hex}00` is the same colour at zero alpha, so
  // the ramp stays neutral.
  const fadeColors = [`${theme.background}00`, theme.background] as const;

  return (
    <View style={styles.row} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {legs.map((leg, index) => {
        const last = index === legs.length - 1;
        return (
          <Fragment key={index}>
            {index > 0 && (
              // Wrapped, and every wrapper pinned at `flexShrink: 0`: an
              // overflowing row must push its tail past the end edge, never
              // squeeze the legs to fit. That is already React Native's
              // default, but not the web renderer's for a raw SVG -- an
              // unwrapped chevron collapses to nothing there.
              <View style={styles.item}>
                <IconForward size={14} color={theme.textSecondary} />
              </View>
            )}
            <View
              style={styles.item}
              onLayout={
                last
                  ? (event) => {
                      setTailStart(event.nativeEvent.layout.x);
                      setTailWidth(event.nativeEvent.layout.width);
                    }
                  : undefined
              }
            >
              <LegSummary leg={leg} />
            </View>
          </Fragment>
        );
      })}

      {overflowing && (
        <LinearGradient
          // `end: 0` rather than `right: 0`, and the colour ramp reversed
          // under RTL: in Hebrew the strip runs right-to-left, so the hidden
          // tail -- and therefore the fade -- is at the LEFT edge.
          colors={I18nManager.isRTL ? [fadeColors[1], fadeColors[0]] : [fadeColors[0], fadeColors[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          pointerEvents="none"
          style={styles.fade}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: Spacing.two,
    // Bounds the strip to the card's width so an overflowing timeline never
    // pushes the card itself wider inside the carousel, and clips whatever
    // runs past the end edge.
    overflow: 'hidden',
  },
  item: {
    flexShrink: 0,
  },
  fade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    end: 0,
    width: FADE_WIDTH,
  },
});
