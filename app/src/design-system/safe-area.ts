import { I18nManager } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The safe-area insets on the line's start and end sides, for `paddingStart`,
 * `marginStart`, `start` and their `End` pairs.
 *
 * Zero on a phone held upright. Not zero on iPhone Duo, whose system bars run
 * down one side of the screen (about 84pt), or on any iPhone in landscape.
 * Anything a rider reads or taps must sit inside them; a map or a backing
 * may run under them.
 *
 * Safe-area insets are physical (left and right) and the app's layout is
 * logical, so in Hebrew the start side is the right one.
 *
 * Apply them as start/end padding or margin, never through a `SafeAreaView`:
 * its `'left'`/`'right'` edges do not take effect in Hebrew, and the left and
 * right padding it writes overrides a start/end padding set on the same view.
 * A margin on a `SafeAreaView` is fine.
 */
export function useSideInsets(): { start: number; end: number } {
  const insets = useSafeAreaInsets();
  return I18nManager.isRTL ? { start: insets.right, end: insets.left } : { start: insets.left, end: insets.right };
}
