import BottomSheet, { BottomSheetView, type BottomSheetBackgroundProps } from '@gorhom/bottom-sheet';
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Border, Glass, Radius, Size, Space, useColors, useGlassEnabled } from '@/design-system';

/** How much of the screen the sheet may grow to before its content scrolls:
 *  the map above it stays the larger part of the screen at rest, but a long
 *  step list can still be read whole. */
const MAX_HEIGHT_RATIO = 0.72;

export type SheetTone = 'default' | 'alight';

/**
 * The one sheet the trip preview and the running journey share: floating
 * over the map, inset from the screen's edges with concentric corners, sized
 * to its content. Liquid Glass on iOS 26, a solid floating surface elsewhere
 * -- and a solid high-visibility fill for the get-off moment, which must read
 * the same over any map.
 *
 * Never closes: it is the page, not a popup.
 */
export function FloatingSheet({
  children,
  tone = 'default',
  onHeightChange,
}: {
  children: ReactNode;
  tone?: SheetTone;
  /** The sheet's resting height including its bottom gap, for a map to keep
   *  what it frames above it. */
  onHeightChange?: (height: number) => void;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const glass = useGlassEnabled();
  const bottomInset = Math.max(insets.bottom, Space.sm);

  // Memoized: a new component identity per render would remount the glass on
  // every tick of the journey's clock, and glass that remounts flickers.
  const Background = useMemo(() => {
    function SheetBackground({ style }: BottomSheetBackgroundProps) {
      if (tone === 'alight') {
        return <View pointerEvents="none" style={[style, styles.shape, { backgroundColor: colors.alightFill }]} />;
      }
      if (glass) return <Glass variant="regular" shape="none" pointerEvents="none" style={[style, styles.shape]} />;
      return (
        <View
          pointerEvents="none"
          style={[style, styles.shape, { backgroundColor: colors.surfaceFloating, borderWidth: Border.hairline, borderColor: colors.separator }]}
        />
      );
    }
    return SheetBackground;
  }, [tone, glass, colors]);

  return (
    <BottomSheet
      index={0}
      detached
      bottomInset={bottomInset}
      style={styles.sheet}
      enableDynamicSizing
      maxDynamicContentSize={Math.round(height * MAX_HEIGHT_RATIO)}
      enablePanDownToClose={false}
      backgroundComponent={Background}
      handleIndicatorStyle={{
        backgroundColor: tone === 'alight' ? colors.onAlightFill : colors.textTertiary,
        width: Size.grabber.width,
        height: Size.grabber.height,
      }}
    >
      <BottomSheetView
        style={styles.content}
        onLayout={(event) => onHeightChange?.(Math.round(event.nativeEvent.layout.height) + bottomInset + Size.grabber.height + Space.lg)}
      >
        {children}
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    marginHorizontal: Space.sm,
  },
  shape: {
    borderRadius: Radius.xxl,
    overflow: 'hidden',
  },
  content: {
    paddingHorizontal: Space.lg,
    paddingBottom: Space.lg,
    gap: Space.md,
  },
});
