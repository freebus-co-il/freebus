import BottomSheet, { type BottomSheetBackgroundProps } from '@gorhom/bottom-sheet';
import { useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Border, Glass, Radius, Size, Space, useColors, useGlassEnabled, withAlpha } from '@/design-system';
import type { EdgePadding } from '@/features/results/trip-map';

/** How much of the screen the drawer covers at rest: enough for a page's
 *  header and first rows, leaving the map the larger share -- these pages are
 *  about the map first. */
export const MAP_SHEET_PEEK_RATIO = 0.4;
/** How far the drawer's glass leans toward its solid surface. */
const SHEET_TINT = 0.6;
/** The map screen's back chip, which a map's framing has to clear. */
export const MAP_BACK_CHIP_SIZE = Size.control.md;
/** The chip's gap below the status bar, and the drawer's below the chip. */
export const MAP_BACK_CHIP_GAP = Space.sm;

/** The drawer's height at peek, for a map to keep its framed content above. */
export function useMapSheetPeekHeight(): number {
  const { height } = useWindowDimensions();
  return Math.round(height * MAP_SHEET_PEEK_RATIO);
}

/** The part of a map under the drawer that is actually open to view: below
 *  the status bar and the back chip, above the drawer at rest. Memoized -- a
 *  map re-fits its camera when this object changes. */
export function useMapSheetEdgePadding(): EdgePadding {
  const insets = useSafeAreaInsets();
  const peek = useMapSheetPeekHeight();
  return useMemo(
    () => ({
      top: insets.top + MAP_BACK_CHIP_SIZE + Space.lg,
      right: Space.xxl,
      bottom: peek + Space.lg,
      left: Space.xxl,
    }),
    [insets.top, peek],
  );
}

/**
 * The page drawer over a full-screen map: rests at peek, drags up to just
 * under the back chip -- never over it, so the way back stays in reach and
 * the page's header is never hidden behind it -- and never closes: the
 * content is the page, not a popup.
 *
 * Dynamic sizing is off so the two snap points are exactly the two resting
 * places. Liquid Glass on iOS 26, like the journey's floating sheet, but
 * tinted toward the solid surface: unlike that sheet it holds a whole page of
 * secondary text, which washed out over a bright map. A solid floating surface
 * with a hairline edge elsewhere, and no shadow.
 */
export function MapSheet({ children }: { children: ReactNode }) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const peek = useMapSheetPeekHeight();
  const glass = useGlassEnabled();
  const snapPoints = useMemo(
    () => [peek, height - (insets.top + MAP_BACK_CHIP_GAP + MAP_BACK_CHIP_SIZE + MAP_BACK_CHIP_GAP)],
    [peek, height, insets.top],
  );

  // Memoized: a new component identity per render would remount the glass,
  // and glass that remounts flickers.
  const Background = useMemo(() => {
    function SheetBackground({ style }: BottomSheetBackgroundProps) {
      if (glass) {
        // Glass rounds all four corners alike, so it runs past the screen's
        // bottom edge by a radius to leave only the top corners showing.
        return (
          <View pointerEvents="none" style={style}>
            <Glass variant="tinted" tint={withAlpha(colors.surfaceFloating, SHEET_TINT)} shape="none" style={styles.glass} />
          </View>
        );
      }
      return (
        <View
          pointerEvents="none"
          style={[
            style,
            {
              backgroundColor: colors.surfaceFloating,
              borderTopLeftRadius: Radius.xxl,
              borderTopRightRadius: Radius.xxl,
              // iOS only: on Android a border on a view with only its top
              // corners rounded tints the whole fill.
              ...(Platform.OS === 'ios' ? { borderWidth: Border.hairline, borderColor: colors.separator } : null),
            },
          ]}
        />
      );
    }
    return SheetBackground;
  }, [glass, colors]);

  return (
    <BottomSheet
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose={false}
      backgroundComponent={Background}
      handleIndicatorStyle={{ backgroundColor: colors.textTertiary, width: Size.grabber.width, height: Size.grabber.height }}
    >
      {children}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  glass: {
    position: 'absolute', top: 0, left: 0, right: 0,
    bottom: -Radius.xxl,
    borderRadius: Radius.xxl,
  },
});
