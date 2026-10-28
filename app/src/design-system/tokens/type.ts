import { Platform, type TextStyle } from 'react-native';

/**
 * The type scale: Apple's text styles, which Material's scale is close enough
 * to that one table serves both. System fonts only -- they carry Hebrew, Dynamic
 * Type and optical sizing for free. See design-system.md 3.2.
 */
type Style = Required<Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight'>> & {
  /** The weight when `emphasized`. */
  emphasized: TextStyle['fontWeight'];
  /** Cap on Dynamic Type growth, for text that sits in a fixed-size shape. */
  maxScale?: number;
};

export const Type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: 700, emphasized: 800 },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: 700, emphasized: 800 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: 700, emphasized: 800 },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: 600, emphasized: 700 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: 600, emphasized: 700 },
  body: { fontSize: 17, lineHeight: 22, fontWeight: 400, emphasized: 600 },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: 400, emphasized: 600 },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: 400, emphasized: 600 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: 400, emphasized: 600 },
  caption1: { fontSize: 12, lineHeight: 16, fontWeight: 400, emphasized: 600 },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: 500, emphasized: 700, maxScale: 1.4 },
  /** The "3 min" hero on trip, journey and the smart suggestion. */
  countdown: { fontSize: 34, lineHeight: 41, fontWeight: 700, emphasized: 800, maxScale: 1.3 },
} as const satisfies Record<string, Style>;

export type TextVariant = keyof typeof Type;

/** Monospace, for the rare code-like string. */
export const MonoFamily = Platform.select({ ios: 'ui-monospace', default: 'monospace' });
