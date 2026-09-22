import { View, type ViewProps } from 'react-native';

import { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedViewProps = ViewProps & {
  lightColor?: string;
  darkColor?: string;
  type?: ThemeColor;
};

// No `type` means transparent, not `background` -- most things in this app
// sit directly on the page and want nothing painted at all, and a wrapper
// that defaulted to a colour would quietly cover whatever it was laid over
// (a map, a scrim, the ramp of a fade). The few views that really do own a
// surface -- page roots, panels docked over a map, sheets -- say so.
export function ThemedView({ style, lightColor, darkColor, type, ...otherProps }: ThemedViewProps) {
  const theme = useTheme();

  return <View style={[type ? { backgroundColor: theme[type] } : null, style]} {...otherProps} />;
}
