import BottomSheet from '@gorhom/bottom-sheet';
import { useMemo, type ReactNode } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Border, Radius, Size, Space, useColors } from '@/design-system';
import type { EdgePadding } from '@/features/results/trip-map';

/** How much of the screen the drawer covers at rest: enough for a page's
 *  header and first rows, leaving the map the larger share -- these pages are
 *  about the map first. */
export const MAP_SHEET_PEEK_RATIO = 0.4;
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
 * places. A solid floating surface with a hairline edge -- it holds content, so
 * it is not glass -- and no shadow.
 */
export function MapSheet({ children }: { children: ReactNode }) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const peek = useMapSheetPeekHeight();
  const snapPoints = useMemo(
    () => [peek, height - (insets.top + MAP_BACK_CHIP_GAP + MAP_BACK_CHIP_SIZE + MAP_BACK_CHIP_GAP)],
    [peek, height, insets.top],
  );

  return (
    <BottomSheet
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose={false}
      backgroundStyle={{
        backgroundColor: colors.surfaceFloating,
        borderTopLeftRadius: Radius.xxl,
        borderTopRightRadius: Radius.xxl,
        // iOS only: on Android a border on a view with only its top corners
        // rounded tints the whole fill.
        ...(Platform.OS === 'ios' ? { borderWidth: Border.hairline, borderColor: colors.separator } : null),
      }}
      handleIndicatorStyle={{ backgroundColor: colors.textTertiary, width: Size.grabber.width, height: Size.grabber.height }}
    >
      {children}
    </BottomSheet>
  );
}
