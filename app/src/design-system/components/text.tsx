import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { TEXT_ALIGN_START } from '@/i18n/direction';

import { useColors } from '../theme';
import { Type, type ColorRole, type TextVariant } from '../tokens';

export type TextProps = RNTextProps & {
  variant?: TextVariant;
  /** A colour role, or a literal colour (ink on an operator colour). */
  color?: ColorRole | (string & {});
  /** The variant's heavier weight. */
  emphasized?: boolean;
  /** Tabular digits: times, countdowns, distances, line numbers. */
  numeric?: boolean;
  align?: 'start' | 'center' | 'end';
};

/**
 * All text in the app. Starts at the line's start in both directions (see
 * `TEXT_ALIGN_START`); `align` or a `style` textAlign still wins.
 */
export function Text({
  variant = 'body',
  color = 'textPrimary',
  emphasized = false,
  numeric = false,
  align = 'start',
  style,
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  const colors = useColors();
  const spec = Type[variant];
  const ink = color in colors ? colors[color as ColorRole] : color;
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? ('maxScale' in spec ? spec.maxScale : undefined)}
      style={[
        {
          color: ink,
          fontSize: spec.fontSize,
          lineHeight: spec.lineHeight,
          fontWeight: emphasized ? spec.emphasized : spec.fontWeight,
          textAlign: align === 'start' ? TEXT_ALIGN_START : align === 'center' ? 'center' : 'right',
        },
        (numeric || variant === 'countdown') && { fontVariant: ['tabular-nums'] },
        style,
      ]}
      {...rest}
    />
  );
}
