/**
 * Colour roles, light and dark. See docs/private/design-system/design-system.md 3.1.
 *
 * Plain values, not `PlatformColor`: the app has its own light/dark override
 * (Settings), and a system colour follows the window's trait collection, which
 * only matches the override because `applyColorSchemeOverride` pushes it to
 * `Appearance`. Plain values keep JS-side consumers (maps, gradients) exact too.
 *
 * Content is solid, chrome is glass: nothing here is a glass colour. Glass is a
 * material (`components/glass.tsx`) and falls back to `surfaceFloating`.
 */
const light = {
  /** The page behind grouped lists. The default page. */
  bgGrouped: '#F2F2F7',
  /** Full-bleed content: long catalogues, sheet bodies, the journey screen. */
  bgPlain: '#FFFFFF',
  /** A list group or content card. */
  surfaceGroup: '#FFFFFF',
  /** A tile or field inside a group. */
  surfaceNested: '#F2F2F7',
  /** A floating panel when there is no glass: the glass fallback, sheets, map panels. */
  surfaceFloating: '#FFFFFF',
  /** A control's own fill: chips, the search capsule, icon buttons at rest. */
  controlFill: '#FFFFFF',
  /** The edge a control needs where its fill alone would vanish into the page. */
  controlEdge: 'rgba(60,60,67,0.18)',
  /** Segmented tracks, progress tracks, skeleton blocks. */
  trackFill: 'rgba(118,118,128,0.12)',
  /** A row, tile or card being pressed. */
  fillPressed: '#E5E5EA',
  /** The raised segment of a segmented control. Lighter than the group in
   *  dark mode, or the chosen side sinks into the card around it. */
  segmentThumb: '#FFFFFF',

  textPrimary: '#000000',
  /** 5.3:1 on white, 4.8:1 on bgGrouped. Apple's secondaryLabel is only 3.4:1. */
  textSecondary: '#6B6B70',
  textTertiary: 'rgba(60,60,67,0.30)',
  /** Between rows inside one group. */
  separator: 'rgba(60,60,67,0.20)',
  /** A text field's edge, an unselected tile's edge. */
  borderControl: '#C6C6C8',

  /** Primary action, selection, links. Ink: the logo is black and white, and
   *  the transit lines own all the hue. */
  accent: '#000000',
  onAccent: '#FFFFFF',

  /** Realtime. Text-safe. */
  live: '#187A4C',
  danger: '#C4291C',
  warning: '#B45309',
  /** Walk legs. Graphic only, never text. */
  walk: '#f59e0b',
  /** The get-off moment. */
  getOff: '#FF5B24',
  /** Content on a danger / getOff / walk fill. */
  onStatus: '#FFFFFF',
  /** A bus's own front sign: amber dot-matrix on black, for matching the
   *  vehicle at a glance. The same in both schemes, like the real thing. */
  busSign: '#FFB21A',
  busSignPanel: '#0B0B0B',
  scrim: 'rgba(0,0,0,0.40)',

  /** The ring around map markers. Theme-aware: a white ring on a dark map glows. */
  mapMarkerRing: '#FFFFFF',
} as const;

export type ColorRole = keyof typeof light;
export type Palette = Record<ColorRole, string>;

const dark: Palette = {
  bgGrouped: '#000000',
  bgPlain: '#000000',
  surfaceGroup: '#1C1C1E',
  surfaceNested: '#2C2C2E',
  surfaceFloating: '#1C1C1E',
  controlFill: 'rgba(118,118,128,0.24)',
  controlEdge: 'rgba(255,255,255,0.06)',
  trackFill: 'rgba(118,118,128,0.24)',
  fillPressed: '#2C2C2E',
  segmentThumb: '#636366',

  textPrimary: '#FFFFFF',
  textSecondary: '#9A9AA0',
  textTertiary: 'rgba(235,235,245,0.30)',
  separator: 'rgba(84,84,88,0.60)',
  borderControl: '#38383A',

  accent: '#FFFFFF',
  onAccent: '#000000',

  live: '#30D158',
  danger: '#FF6B60',
  warning: '#FFB340',
  walk: '#f59e0b',
  getOff: '#FF5B24',
  onStatus: '#FFFFFF',
  busSign: '#FFB21A',
  busSignPanel: '#0B0B0B',
  scrim: 'rgba(0,0,0,0.60)',

  mapMarkerRing: '#1C1C1E',
};

export const Palettes: Record<'light' | 'dark', Palette> = { light, dark };

/**
 * The text inks for content on Liquid Glass. Glass takes on whatever is
 * behind it (a bright map, a dark sea), so the grey that reads on a solid
 * surface turns to mud on it: secondary and tertiary text go near-full ink
 * instead. Applied by `GlassInk` (inside `Glass`, and glass sheets).
 */
export const GlassPalettes: Record<'light' | 'dark', Palette> = {
  light: {
    ...light,
    textSecondary: 'rgba(0,0,0,0.72)',
    textTertiary: 'rgba(0,0,0,0.50)',
  },
  dark: {
    ...dark,
    textSecondary: 'rgba(255,255,255,0.86)',
    textTertiary: 'rgba(255,255,255,0.64)',
  },
};

/** A colour with an alpha channel, for fades and dimmed map lines. Takes a
 *  6-digit hex; anything else comes back unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `#${match[1]}${a}`;
}
