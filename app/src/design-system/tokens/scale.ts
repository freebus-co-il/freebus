import { Platform, StyleSheet } from 'react-native';

const ios = Platform.OS === 'ios';

/** 4pt grid. See design-system.md 3.3. */
export const Space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
  giant: 64,
} as const;

/** Page rhythm, built from `Space`. */
export const Layout = {
  /** Horizontal inset of every page, and of a grouped list from the screen edge. */
  pageInset: Space.lg,
  /** Between two groups or top-level sections. */
  sectionGap: Space.xxxl,
  /** From a section header to its group. */
  headerToGroup: Space.sm,
  /** From a group to its footer note. */
  groupFooterGap: Space.sm,
  rowPaddingV: Space.md,
  rowPaddingH: Space.lg,
} as const;

/**
 * Corner radii. Concentric: a shape inside another uses `outer - padding`, which
 * is why the scale steps by 8. See design-system.md 3.4.
 */
export const Radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  full: 9999,
} as const;

/** Fixed dimensions. Button heights come from here, never from padding plus
 *  line height. See design-system.md 3.5. */
export const Size = {
  touchMin: ios ? 44 : 48,
  control: { sm: 32, md: ios ? 44 : 48, lg: ios ? 52 : 56 },
  fab: 56,
  row: { min: ios ? 52 : 56, dense: ios ? 44 : 48 },
  icon: { xs: 12, sm: 16, md: 20, lg: 24, xl: 32 },
  /** The leading icon tile in a list row. */
  leadingTile: 30,
  mapMarker: 28,
  grabber: { width: 36, height: 5 },
} as const;

export type IconSize = keyof typeof Size.icon;

export const Border = {
  hairline: StyleSheet.hairlineWidth,
  default: 1,
  selected: 2,
} as const;

export const Opacity = {
  disabled: 0.38,
  /** A press on something with no fill to change. */
  pressed: 0.7,
  done: 0.5,
  dimmed: 0.3,
} as const;

/**
 * Springs by duration and damping ratio, for Reanimated's `withSpring`.
 * Under Reduce Motion use `Motion.fade` instead. See design-system.md 3.9.
 */
export const Motion = {
  snappy: { duration: 250, dampingRatio: 0.9 },
  smooth: { duration: 350, dampingRatio: 1 },
  bouncy: { duration: 450, dampingRatio: 0.7 },
  /** Glass shapes flowing between two screens: long enough for the liquid
   *  blend to be seen, with a slight settle at the end. */
  morph: { duration: 550, dampingRatio: 0.82 },
  fade: { duration: 200 },
} as const;
