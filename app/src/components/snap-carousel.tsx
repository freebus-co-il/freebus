import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement } from 'react';
import { FlatList, StyleSheet, View, useWindowDimensions, type ViewToken } from 'react-native';

import { Spacing } from '@/constants/theme';
import { hapticSelected } from '@/lib/haptics';

import { shouldTickOnCardChange } from './carousel-tick';

/** How much of the page edge stays clear on both sides, so a card reads as a
 *  card floating over the map rather than a bar welded to the screen edges. */
const SIDE_INSET = Spacing.three;
/** The sliver of the NEXT card left showing at the trailing edge -- the only
 *  thing that tells a rider there is more to swipe to. */
const PEEK = Spacing.four;
const GAP = Spacing.two;

export type SnapCarouselHandle = {
  /** Brings a card on screen, animated. */
  scrollToIndex: (index: number) => void;
};

export type SnapCarouselProps<T> = {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactElement;
  /** Fired when a swipe settles on a different card. */
  onActiveIndexChange: (index: number) => void;
  /** The card showing on first render. */
  initialIndex?: number;
  /** Fired when the rider starts dragging -- a swipe of their own, as opposed
   *  to one `scrollToIndex` made for them. */
  onUserSwipe?: () => void;
};

/**
 * One card per swipe, horizontally, over a map. The card on screen IS the
 * selection -- there's no separate "selected" state to keep in sync, because
 * settling on a card is what tells the map what to show.
 *
 * Active-card tracking goes through `onViewableItemsChanged`, which reports
 * real data indices, rather than through `contentOffset.x` arithmetic:
 * React Native mirrors horizontal scroll offsets inconsistently between iOS
 * and Android under RTL, and this app is Hebrew-first, so offset math here
 * would be a coin flip per platform. Viewability is measured from actual
 * item layout and needs no RTL correction at all.
 */
function SnapCarouselInner<T>(
  { data, keyExtractor, renderItem, onActiveIndexChange, initialIndex = 0, onUserSwipe }: SnapCarouselProps<T>,
  ref: React.ForwardedRef<SnapCarouselHandle>,
) {
  const { width } = useWindowDimensions();
  const cardWidth = width - SIDE_INSET * 2 - PEEK;
  const interval = cardWidth + GAP;
  const listRef = useRef<FlatList<T>>(null);

  // `FlatList` captures both of these on mount and throws if either changes
  // identity later, so the live callback is reached through a ref instead of
  // being closed over.
  const changeRef = useRef(onActiveIndexChange);
  useEffect(() => {
    changeRef.current = onActiveIndexChange;
  }, [onActiveIndexChange]);

  /**
   * Whether the card now arriving is one the RIDER is bringing in.
   *
   * Set when a drag starts and cleared when the scroll settles, so the tick
   * below answers a swipe and nothing else. The journey screen scrolls this
   * carousel itself as legs complete, and a buzz there would be the app
   * reporting its own movement back to a rider who did not ask for it --
   * on top of the haptic that leg change already has.
   */
  const userDriven = useRef(false);
  /** The last card reported. `null` until the first report, which is the
   *  carousel arriving rather than moving. */
  const lastIndex = useRef<number | null>(null);

  // Held in lazy `useState`, not `useRef().current` -- both give one stable
  // value for the component's lifetime, but reading a ref during render is a
  // lint error (and unsafe under concurrent rendering).
  const [handleViewableChanged] = useState(() => ({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const index = viewableItems[0]?.index;
    if (index == null) return;
    const previous = lastIndex.current;
    lastIndex.current = index;
    // Fires as the incoming card crosses the 60% threshold, which is where
    // the swipe reads as decided -- not at momentum end, by which time the
    // card has already been sitting there. `shouldTickOnCardChange` holds
    // the conditions, and its tests are the only check on them that does
    // not need a device to feel.
    if (shouldTickOnCardChange(previous, index, userDriven.current)) hapticSelected();
    changeRef.current(index);
  });

  // 60% of an item -- the settled card covers ~100% of its own width while
  // the peeking neighbour shows only its sliver, so exactly one card is ever
  // "viewable" and the active index never flickers mid-swipe.
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 60 }));

  const snapToOffsets = useMemo(() => data.map((_, index) => index * interval), [data, interval]);

  // Every card is the same width, so where each one sits is arithmetic -- which
  // is what lets `initialScrollIndex` and `scrollToIndex` land on a card
  // without measuring first. `offset` is the card's SNAP POINT, not its edge:
  // it leaves out the leading inset, because `initialScrollIndex` scrolls to
  // `offset` exactly and has no `viewOffset` to take the inset back out -- a
  // running journey opened 16pt off its card, bleeding past the screen edge.
  const getItemLayout = useCallback(
    (_: ArrayLike<T> | null | undefined, index: number) => ({
      length: cardWidth,
      offset: index * interval,
      index,
    }),
    [cardWidth, interval],
  );

  // Under RTL a list cannot scroll before its content has been laid out -- it
  // warns and drops the call, and a screen asking for a card as it mounts
  // would never get there. So a request that arrives early waits here, and
  // is applied the moment there is content to scroll.
  const laidOut = useRef(false);
  const pendingIndex = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => {
      if (index < 0 || index >= data.length) return;
      // This move is the app's, not the rider's. Cleared here as well as at
      // momentum end because a slow drag released with no fling never
      // produces a momentum event to clear it.
      userDriven.current = false;
      if (!laidOut.current) {
        pendingIndex.current = index;
        return;
      }
      listRef.current?.scrollToIndex({ index, animated: true });
    },
  }), [data.length]);

  const handleContentSizeChange = useCallback((contentWidth: number) => {
    if (laidOut.current || contentWidth === 0) return;
    laidOut.current = true;
    const index = pendingIndex.current;
    pendingIndex.current = null;
    if (index !== null) listRef.current?.scrollToIndex({ index, animated: false });
  }, []);

  return (
    <FlatList
      ref={listRef}
      horizontal
      data={data}
      keyExtractor={keyExtractor}
      showsHorizontalScrollIndicator={false}
      snapToOffsets={snapToOffsets}
      decelerationRate="fast"
      // One card per swipe, however hard the fling: a rider reading a journey
      // step by step should never skip past the step they meant to read.
      disableIntervalMomentum
      contentContainerStyle={styles.content}
      onViewableItemsChanged={handleViewableChanged}
      viewabilityConfig={viewabilityConfig}
      getItemLayout={getItemLayout}
      initialScrollIndex={initialIndex > 0 && initialIndex < data.length ? initialIndex : undefined}
      onScrollBeginDrag={() => {
        userDriven.current = true;
        onUserSwipe?.();
      }}
      onMomentumScrollEnd={() => {
        userDriven.current = false;
      }}
      onContentSizeChange={handleContentSizeChange}
      renderItem={({ item, index }) => (
        // Fixed width, stretched height: the content row sizes itself to the
        // tallest card and every other card matches it, so one taller card
        // doesn't leave its neighbours looking clipped.
        <View style={{ width: cardWidth }}>{renderItem(item, index)}</View>
      )}
    />
  );
}

export const SnapCarousel = forwardRef(SnapCarouselInner) as <T>(
  props: SnapCarouselProps<T> & { ref?: React.Ref<SnapCarouselHandle> },
) => ReactElement;

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: SIDE_INSET,
    gap: GAP,
  },
});
