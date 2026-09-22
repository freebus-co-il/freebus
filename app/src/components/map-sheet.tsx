import BottomSheet from '@gorhom/bottom-sheet';
import { useMemo, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing } from '@/constants/theme';
import type { EdgePadding } from '@/features/results/trip-map';
import { useTheme } from '@/hooks/use-theme';

/** How much of the screen the drawer covers at rest: enough for a page's
 *  header and first rows, leaving the map the larger share -- these pages are
 *  about the map first. */
export const MAP_SHEET_PEEK_RATIO = 0.4;
/** The map screen's back chip, which a map's framing has to clear. */
export const MAP_BACK_CHIP_SIZE = 44;
/** The chip's gap below the status bar, and the drawer's below the chip. */
export const MAP_BACK_CHIP_GAP = Spacing.two;
const SHEET_RADIUS = 18;

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
      top: insets.top + MAP_BACK_CHIP_SIZE + Spacing.three,
      right: Spacing.four,
      bottom: peek + Spacing.three,
      left: Spacing.four,
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
 * places. Flat, like every card in the app: a background and a hairline, no
 * shadow.
 */
export function MapSheet({ children }: { children: ReactNode }) {
  const theme = useTheme();
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
        backgroundColor: theme.background,
        borderTopLeftRadius: SHEET_RADIUS,
        borderTopRightRadius: SHEET_RADIUS,
        borderWidth: 1.5,
        borderColor: theme.borderMuted,
      }}
      handleIndicatorStyle={{ backgroundColor: theme.borderMuted }}
    >
      {children}
    </BottomSheet>
  );
}
