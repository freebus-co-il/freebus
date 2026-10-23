import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors, useGlassEnabled } from '../theme';
import { Border } from '../tokens';
import { Glass } from './glass';

/** How far the content has to move before the header's backing mounts. */
const SCROLLED_AT = 1;
/** How far the content scrolls while the backing fades in: tied to the
 *  scroll, not a timed animation, so it reads as the content passing under
 *  the header rather than something switching on. */
const FADE_DISTANCE = 32;
/** The backing's opacity floor once mounted: glass at opacity 0 never draws
 *  again (see `Glass`), so it fades from just above zero. */
const MIN_OPACITY = 0.01;

/**
 * The state a `ScrollHeader` and the list under it share: the header's
 * measured height, which the list pads its top by so its first row starts
 * below the header, and whether the list has scrolled, which gives the header
 * its backing. Spread `onScroll` and `scrollEventThrottle` into the list.
 */
export function useScrollHeader() {
  const [height, setHeight] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const progress = useSharedValue(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(Math.round(event.nativeEvent.layout.height));
  }, []);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    progress.set(Math.min(1, Math.max(MIN_OPACITY, (y - SCROLLED_AT) / FADE_DISTANCE)));
    const next = y > SCROLLED_AT;
    // Bail out on an unchanged value: this runs every frame of a scroll.
    setScrolled((current) => (current === next ? current : next));
  }, [progress]);
  return { height, scrolled, progress, onLayout, onScroll, scrollEventThrottle: 16 } as const;
}

/**
 * A tab root's fixed header -- title, search, chips -- floating over a list
 * that scrolls under it. Tab roots have no native header, so this is the
 * stand-in for one: at rest it has no backing at all and reads as part of the
 * page; once the content scrolls under it, it fades in a Liquid Glass backing on
 * iOS 26, and the page's own solid colour with a hairline everywhere else.
 *
 * Takes the top safe-area inset itself, so the screen must not. Render it
 * AFTER the list, so it draws on top.
 */
export function ScrollHeader({ scrolled, progress, onLayout, children, style }: {
  scrolled: boolean;
  /** From `useScrollHeader`: how far the backing has faded in. */
  progress: SharedValue<number>;
  onLayout: (event: LayoutChangeEvent) => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const glass = useGlassEnabled();
  const fade = useAnimatedStyle(() => ({ opacity: progress.get() }));

  return (
    <View pointerEvents="box-none" onLayout={onLayout} style={[styles.header, { paddingTop: insets.top }, style]}>
      {/* Mounted only while scrolled, and faded through a wrapper rather
          than the glass itself: glass faded to nothing never draws again
          (see `Glass`). */}
      {scrolled && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fade]}>
          {glass ? (
            <Glass variant="regular" shape="none" style={styles.bleed} />
          ) : (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.bgGrouped, borderBottomWidth: Border.hairline, borderBottomColor: colors.separator },
              ]}
            />
          )}
        </Animated.View>
      )}
      {children}
    </View>
  );
}

/** How far the glass runs past the screen's top and sides. Liquid Glass draws
 *  a lit rim on every edge; a bar spanning the screen should only show the one
 *  along its bottom, where the content meets it. */
const BLEED = 40;

const styles = StyleSheet.create({
  bleed: {
    position: 'absolute',
    top: -BLEED,
    start: -BLEED,
    end: -BLEED,
    bottom: 0,
  },
  header: {
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
  },
});
