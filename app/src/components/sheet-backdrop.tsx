import { Pressable, StyleSheet } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/**
 * What sits behind a bottom sheet: the tap-to-dismiss target, and the scrim
 * that dims whatever the sheet is covering.
 *
 * It was transparent before, which on a white page meant a white sheet
 * arrived over white content with nothing between them -- the sheet and the
 * screen it covered read as one surface, and the only clue anything had
 * happened was the grabber.
 *
 * Shared because there are five of these, and five copies of a dismiss
 * target are five chances for one of them to be the odd one out.
 */
export function SheetBackdrop({ onPress }: { onPress: () => void }) {
  const theme = useTheme();

  return <Pressable style={[styles.backdrop, { backgroundColor: theme.scrim }]} onPress={onPress} />;
}

/**
 * The top edge of the sheet itself, to be spread into its style.
 *
 * The scrim alone is not enough in dark mode: the page is already black, so
 * dimming it changes nothing and a black sheet still dissolves into a black
 * screen. A hairline draws the boundary the scrim cannot -- the same
 * `borderMuted` line that separates two rows, for the same reason.
 */
export function useSheetEdge() {
  const theme = useTheme();

  return { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.borderMuted };
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
});
