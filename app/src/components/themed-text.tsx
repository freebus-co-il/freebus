import { Platform, StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { TEXT_ALIGN_START } from '@/i18n/direction';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'defaultBold' | 'title' | 'small' | 'smallBold' | 'subtitle' | 'link' | 'linkPrimary' | 'code';
  themeColor?: ThemeColor;
};

/**
 * `textAlign` is stated rather than left to default `auto`, which aligns by the
 * script of the text rather than by the layout -- a Hebrew stop name in the
 * English UI would sit against the right edge. `TEXT_ALIGN_START` is the start
 * of the line in both directions; see it for why that is spelled `'left'`.
 *
 * It goes BEFORE `style`, so a caller asking for `textAlign: 'center'` still
 * wins -- which the centred empty states rely on.
 */
export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      style={[
        { color: theme[themeColor ?? 'text'], textAlign: TEXT_ALIGN_START },
        type === 'default' && styles.default,
        type === 'defaultBold' && styles.defaultBold,
        type === 'title' && styles.title,
        type === 'small' && styles.small,
        type === 'smallBold' && styles.smallBold,
        type === 'subtitle' && styles.subtitle,
        type === 'link' && styles.link,
        type === 'linkPrimary' && styles.linkPrimary,
        type === 'code' && styles.code,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  small: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 500,
  },
  smallBold: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 700,
  },
  default: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 500,
  },
  // The `small`/`smallBold` pair one step up the scale, for the lines a rider
  // acts on -- "Get off at X" carries the weight of the instruction it is.
  defaultBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 700,
  },
  title: {
    fontSize: 48,
    fontWeight: 600,
    lineHeight: 52,
  },
  subtitle: {
    fontSize: 32,
    lineHeight: 44,
    fontWeight: 600,
  },
  link: {
    lineHeight: 30,
    fontSize: 14,
  },
  linkPrimary: {
    lineHeight: 30,
    fontSize: 14,
    color: '#3c87f7',
  },
  code: {
    fontFamily: Fonts.mono,
    fontWeight: Platform.select({ android: 700 }) ?? 500,
    fontSize: 12,
  },
});
