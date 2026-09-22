import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const TIMING = { duration: 260, easing: Easing.out(Easing.cubic) };

/**
 * Content that opens by growing to its own height and closes by shrinking
 * back, pushing whatever sits below it along with it.
 *
 * The content is laid out out of flow, so its natural height can be measured
 * while the box around it is still shut; the box then animates to that height.
 * Content that grows while open -- a spinner that becomes a list -- is followed
 * the same way. Closed content stays mounted until the box has finished
 * shrinking, then unmounts.
 *
 * Reanimated, not React Native's own `Animated`: height is a layout property,
 * and a JS-driven `Animated` height on the new architecture only reaches
 * layout when React happens to re-render -- recorded on the simulator, the
 * box jumped straight open, then flickered shut on the board's next tick.
 */
export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const height = useSharedValue(0);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [rendered, setRendered] = useState(open);

  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (!rendered) return;
    if (open) {
      if (contentHeight !== null) height.set(withTiming(contentHeight, TIMING));
      return;
    }
    const unmount = () => {
      setRendered(false);
      setContentHeight(null);
    };
    // Interrupted by reopening, `finished` is false and the content stays.
    height.set(withTiming(0, TIMING, (finished) => {
      if (finished) scheduleOnRN(unmount);
    }));
  }, [open, rendered, contentHeight, height]);

  const boxStyle = useAnimatedStyle(() => ({ height: height.get() }));

  if (!rendered) return null;

  return (
    <Animated.View style={[styles.box, boxStyle]}>
      <View
        style={styles.content}
        onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: {
    overflow: 'hidden',
  },
  content: {
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
  },
});
