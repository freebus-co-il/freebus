import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector, type PanGesture, type ScrollView } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Icon, Layout, Motion, Separator, Size, Space, useColors, useReduceMotion } from '@/design-system';
import { hapticGestureRecognised, hapticSelected } from '@/lib/haptics';

import { clampDrag, slotDrag, stepAside, targetIndex } from './reorder-math';

/** Long enough that a tap on the row (its options) is never a drag. */
const LONG_PRESS_MS = 300;
/** A touch on the grip that moves less than this is a tap, not a drag. */
const GRIP_SLOP = Space.xs;
/** The lifted row grows this much: it is above the others, with no shadow
 *  to say so (the design system has none). */
const LIFTED_SCALE = 1.03;
/** Where a row with a leading tile starts its text, and so its separator. */
const SEPARATOR_INSET = Layout.rowPaddingH + Size.leadingTile + Space.md;

type Drag = {
  heights: SharedValue<number[]>;
  /** The row being dragged, or -1. */
  active: SharedValue<number>;
  /** The slot it would land in. */
  target: SharedValue<number>;
  /** How far it has been dragged, kept inside the column. */
  dy: SharedValue<number>;
  /** Which of the row's two gestures is driving the drag: 1 the grip, 2 the
   *  long press, 0 none. The first to start owns it; the other stands down. */
  owner: SharedValue<number>;
};

/**
 * A column of rows the rider reorders by dragging: by the grip at the row's
 * end straight away, or anywhere on the row after a long press, which leaves
 * a plain tap on the row to do what the row does. The rows step aside as the
 * dragged one passes their middle, and it settles into its slot on release.
 *
 * Built on Reanimated and Gesture Handler, already native dependencies, rather
 * than a list library: the lists it serves are a handful of rows inside a
 * page that scrolls, which is exactly where virtualised drag lists struggle.
 *
 * Draws its own separators (the rows move, so `ListSection` cannot place them)
 * and is meant to be the ONLY child of a grouped `ListSection`.
 *
 * For a screen reader the grip is an adjustable control: swipe up to move the
 * row earlier, down to move it later.
 */
export function ReorderableRows<T>({
  items,
  keyOf,
  renderRow,
  onMove,
  handleLabel,
  positionLabel,
  onDragChange,
  scrollRef,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The row itself, given the grip to place in its trailing slot. */
  renderRow: (item: T, index: number, grip: ReactNode) => ReactNode;
  onMove: (from: number, to: number) => void;
  handleLabel: (item: T) => string;
  positionLabel: (index: number, count: number) => string;
  /** A drag started or ended: the page should stop scrolling under it. */
  onDragChange?: (dragging: boolean) => void;
  /** The page's (Gesture Handler) scroll view. A drag from the grip blocks
   *  it; without this the scroll claims the vertical swipe and cancels the
   *  drag before it has moved. */
  scrollRef?: RefObject<ScrollView | null>;
}) {
  const heights = useSharedValue<number[]>([]);
  const active = useSharedValue(-1);
  const target = useSharedValue(-1);
  const dy = useSharedValue(0);
  const owner = useSharedValue(0);
  const drag: Drag = { heights, active, target, dy, owner };
  // By key, not index: a row that only moved is not laid out again, so its
  // height has to follow it to its new place in the order.
  const heightByKey = useRef(new Map<string, number>());
  const keys = items.map(keyOf);
  const order = keys.join('|');

  function publishHeights() {
    heights.set(keys.map((key) => heightByKey.current.get(key) ?? 0));
  }

  // The new order has rendered: the rows already sit where the drag left
  // them, so the offsets go back to zero before the frame is drawn.
  useLayoutEffect(() => {
    heights.set(order.split('|').map((key) => heightByKey.current.get(key) ?? 0));
    active.set(-1);
    target.set(-1);
    dy.set(0);
    owner.set(0);
  }, [order, heights, active, target, dy, owner]);

  function drop(from: number, to: number) {
    onDragChange?.(false);
    if (from === to) {
      active.set(-1);
      dy.set(0);
      owner.set(0);
      return;
    }
    // No haptic on the drop: the row landing in its slot is on screen.
    onMove(from, to);
  }

  return (
    <View>
      {items.map((item, index) => (
        <ReorderableRow
          key={keyOf(item)}
          index={index}
          count={items.length}
          drag={drag}
          onLayoutHeight={(height) => {
            heightByKey.current.set(keyOf(item), height);
            publishHeights();
          }}
          onLift={(longPress) => {
            // Only the long press: its lift comes after a beat with nothing
            // on screen, where the grip lifts the moment it is dragged.
            if (longPress) hapticGestureRecognised();
            onDragChange?.(true);
          }}
          onCross={hapticSelected}
          onDrop={drop}
          handleLabel={handleLabel(item)}
          positionLabel={positionLabel(index, items.length)}
          scrollRef={scrollRef}
        >
          {(grip) => renderRow(item, index, grip)}
        </ReorderableRow>
      ))}
    </View>
  );
}

function ReorderableRow({
  index,
  count,
  drag,
  onLayoutHeight,
  onLift,
  onCross,
  onDrop,
  handleLabel,
  positionLabel,
  scrollRef,
  children,
}: {
  index: number;
  count: number;
  drag: Drag;
  onLayoutHeight: (height: number) => void;
  onLift: (longPress: boolean) => void;
  onCross: () => void;
  onDrop: (from: number, to: number) => void;
  handleLabel: string;
  positionLabel: string;
  scrollRef?: RefObject<ScrollView | null>;
  children: (grip: ReactNode) => ReactNode;
}) {
  const colors = useColors();
  const reduceMotion = useReduceMotion();
  const { heights, active, target, dy, owner } = drag;

  function pan(longPress: boolean): PanGesture {
    const me = longPress ? 2 : 1;
    const gesture = Gesture.Pan()
      .onStart(() => {
        if (owner.get() !== 0) return;
        owner.set(me);
        active.set(index);
        target.set(index);
        dy.set(0);
        scheduleOnRN(onLift, longPress);
      })
      .onUpdate((event) => {
        if (owner.get() !== me) return;
        const hs = heights.get();
        const next = clampDrag(hs, index, event.translationY);
        dy.set(next);
        const to = targetIndex(hs, index, next);
        if (to !== target.get()) {
          target.set(to);
          scheduleOnRN(onCross);
        }
      })
      .onEnd(() => {
        if (owner.get() !== me) return;
        const to = target.get();
        // Settle into the slot first, THEN hand the new order to React, so
        // the row is already where the re-render will put it.
        // Dropped whether or not the spring ran its course: a drop that never
        // landed would leave the drag owned and every later drag ignored.
        dy.set(withSpring(slotDrag(heights.get(), index, to), Motion.snappy, () => {
          scheduleOnRN(onDrop, index, to);
        }));
      });
    return longPress ? gesture.activateAfterLongPress(LONG_PRESS_MS) : gesture.minDistance(GRIP_SLOP);
  }

  const gripGesture = scrollRef ? pan(false).blocksExternalGesture(scrollRef) : pan(false);
  const rowGesture = pan(true);

  const style = useAnimatedStyle(() => {
    const from = active.get();
    if (from === -1) return { transform: [{ translateY: 0 }, { scale: 1 }], zIndex: 0 };
    if (from === index) {
      return {
        transform: [{ translateY: dy.get() }, { scale: withTiming(LIFTED_SCALE, Motion.fade) }],
        zIndex: 1,
      };
    }
    const shift = stepAside(heights.get(), index, from, target.get());
    return {
      transform: [{ translateY: reduceMotion ? shift : withSpring(shift, Motion.snappy) }, { scale: 1 }],
      zIndex: 0,
    };
  });

  function onAccessibilityAction(event: AccessibilityActionEvent) {
    // Increment is "earlier": swiping up moves the row up the list.
    if (event.nativeEvent.actionName === 'increment' && index > 0) onDrop(index, index - 1);
    if (event.nativeEvent.actionName === 'decrement' && index < count - 1) onDrop(index, index + 1);
  }

  const grip = (
    <GestureDetector gesture={gripGesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={handleLabel}
        accessibilityValue={{ text: positionLabel }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAccessibilityAction}
        hitSlop={Space.sm}
        style={styles.grip}
      >
        <Icon name="reorder" size="md" color="textSecondary" />
      </View>
    </GestureDetector>
  );

  return (
    <GestureDetector gesture={rowGesture}>
      <Animated.View
        onLayout={(event) => onLayoutHeight(event.nativeEvent.layout.height)}
        // The group's own surface: a lifted row must hide the rows it passes over.
        style={[{ backgroundColor: colors.surfaceGroup }, style]}
      >
        {index > 0 && <Separator insetStart={SEPARATOR_INSET} />}
        {children(grip)}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  grip: {
    minWidth: Size.touchMin,
    minHeight: Size.touchMin,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
