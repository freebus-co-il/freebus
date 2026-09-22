/**
 * The app's colours, in light and dark mode.
 *
 * `background` is the page, and it is the ONLY background most things get:
 * the visual language is inline rows on a bare page, not cards on a tint.
 * It doubles as the ink colour for anything drawn on a `text`-coloured fill
 * (an active segment, a filled chip), which is why it inverts with the theme.
 *
 * `borderControl` is the outline every control wears, and it is a full step
 * stronger than `borderMuted`. They are separate on purpose: `borderMuted`
 * is a divider BETWEEN things, faint because a list of them should not read
 * as a grid, while `borderControl` is the EDGE of one thing and has to hold
 * its own shape against a white page. At the hairline's weight a chip just
 * looks smudged.
 *
 * `surface` is the exception, not the default. It is for the few things that
 * genuinely are not the page: the search field, chips, bottom sheets,
 * selected states, and everything docked over a map -- a map is its own
 * background, so nothing over it can be card-less. Reach for `borderMuted`
 * hairlines to separate rows before reaching for a fill.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    surface: '#F2F2F7',
    textSecondary: '#6B6B70',
    border: '#000000',
    borderMuted: '#E4E4E7',
    borderControl: '#C2C2C7',
    success: '#187A4C',
    danger: '#C4291C',
    /** The get-off moment's whole-window colour in PiP. */
    getOff: '#FF5B24',
    /** Text on `getOff` and `danger` fills. */
    onAccent: '#FFFFFF',
    /** Dims whatever a bottom sheet is covering. See `SheetBackdrop`. */
    scrim: 'rgba(0, 0, 0, 0.45)',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    surface: '#1C1C1E',
    textSecondary: '#9A9AA0',
    border: '#ffffff',
    borderMuted: '#3A3A3C',
    borderControl: '#5C5C60',
    success: '#33D17A',
    danger: '#FF6B60',
    /** The get-off moment's whole-window colour in PiP. */
    getOff: '#FF5B24',
    /** Text on `getOff` and `danger` fills. */
    onAccent: '#FFFFFF',
    /** Dims whatever a bottom sheet is covering. See `SheetBackdrop`. */
    scrim: 'rgba(0, 0, 0, 0.6)',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/**
 * The air between two top-level sections of a page.
 *
 * Its own constant rather than a step on `Spacing`, because it is the one
 * measure that has to be the same on every screen: with no cards drawing
 * boundaries, this gap IS the boundary, and a section that used 32 next to
 * one that used 48 reads as a mistake rather than a rhythm.
 *
 * The page rhythm it belongs to, loosest to tightest:
 *   `SectionGap` (48) between sections, `Spacing.four` (24) inside a cluster
 *   of controls, `Spacing.three` (16) from a heading to the rows under it.
 */
export const SectionGap = 48;

/**
 * The outline every control wears.
 *
 * Controls are white, like the page, and this outline is the whole of what
 * says a search field, a chip or a filter is something you press rather than
 * something you read -- so it has to be the same on all of them.
 *
 * 1, not `hairlineWidth`: a hairline is the divider BETWEEN rows, and a
 * control drawn at the same weight reads as a stray rule rather than an
 * edge. It does not need to be thicker than that, because the contrast
 * comes from `borderControl` instead -- the two trade off, and a strong
 * colour at 1pt is a cleaner edge than a faint one at 1.5.
 */
export const ControlBorderWidth = 1;
