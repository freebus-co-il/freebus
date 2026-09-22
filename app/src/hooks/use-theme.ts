/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, ControlBorderWidth } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Colors[theme];
}

/**
 * The border half of a control's look -- the theme-dependent half, so it
 * cannot live in a `StyleSheet`. Spread it into a style array next to the
 * control's own layout: `style={[styles.chip, useControlOutline()]}`.
 */
export function useControlOutline() {
  const theme = useTheme();

  return { borderWidth: ControlBorderWidth, borderColor: theme.borderControl };
}
