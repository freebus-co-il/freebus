import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The tab bar's own height above the home indicator: the classic bar, and
 *  the room iOS 26's floating glass bar takes (it floats a few points higher). */
const TAB_BAR_HEIGHT = 49;
const FLOAT_CLEARANCE = 8;

/**
 * How much room a tab root's scroll content needs at its end so its last row
 * can scroll clear of the tab bar.
 *
 * iOS draws the tab bar over the content (on iOS 26 it is a floating glass
 * bar), and automatic content-inset adjustment does not reach these screens'
 * scroll views -- so the room is added explicitly. Android's native tabs
 * already lay tab content out above the navigation bar.
 */
export function useTabBarInset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'ios' ? insets.bottom + TAB_BAR_HEIGHT + FLOAT_CLEARANCE : 0;
}
