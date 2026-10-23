import { SymbolView, type AndroidSymbol, type SymbolWeight } from 'expo-symbols';
import type { SFSymbol } from 'sf-symbols-typescript';
import { I18nManager, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '../theme';
import { Size, type ColorRole, type IconSize } from '../tokens';

type Glyph = { ios: SFSymbol; android: AndroidSymbol };

/**
 * Every icon in the app, by what it MEANS. Each maps to an SF Symbol on iOS
 * and a Material Symbol on Android and web. See design-system.md 4.
 */
const GLYPHS = {
  search: { ios: 'magnifyingglass', android: 'search' },
  map: { ios: 'map', android: 'map' },
  place: { ios: 'mappin.and.ellipse', android: 'location_on' },
  pin: { ios: 'mappin', android: 'location_on' },
  currentLocation: { ios: 'location', android: 'my_location' },
  navigate: { ios: 'location.fill', android: 'near_me' },
  home: { ios: 'house', android: 'home' },
  homeFill: { ios: 'house.fill', android: 'home' },
  work: { ios: 'briefcase', android: 'work' },
  add: { ios: 'plus', android: 'add' },
  close: { ios: 'xmark', android: 'close' },
  check: { ios: 'checkmark', android: 'check' },
  chevronDown: { ios: 'chevron.down', android: 'expand_more' },
  chevronUp: { ios: 'chevron.up', android: 'expand_less' },
  swap: { ios: 'arrow.up.arrow.down', android: 'swap_vert' },
  time: { ios: 'clock', android: 'schedule' },
  alarm: { ios: 'alarm', android: 'alarm' },
  calendar: { ios: 'calendar', android: 'calendar_today' },
  settings: { ios: 'gearshape', android: 'settings' },
  settingsFill: { ios: 'gearshape.fill', android: 'settings' },
  lines: { ios: 'point.topleft.down.to.point.bottomright.curvepath', android: 'route' },
  linesFill: { ios: 'point.topleft.down.to.point.bottomright.curvepath.fill', android: 'route' },
  stations: { ios: 'signpost.right', android: 'signpost' },
  stationsFill: { ios: 'signpost.right.fill', android: 'signpost' },
  operator: { ios: 'building.2', android: 'apartment' },
  bus: { ios: 'bus.fill', android: 'directions_bus' },
  train: { ios: 'tram.fill', android: 'train' },
  ferry: { ios: 'ferry.fill', android: 'directions_boat' },
  taxi: { ios: 'car.fill', android: 'local_taxi' },
  walk: { ios: 'figure.walk', android: 'directions_walk' },
  live: { ios: 'dot.radiowaves.up.forward', android: 'sensors' },
  filter: { ios: 'line.3.horizontal.decrease', android: 'filter_list' },
  refresh: { ios: 'arrow.clockwise', android: 'refresh' },
  edit: { ios: 'pencil', android: 'edit' },
  delete: { ios: 'trash', android: 'delete' },
  lock: { ios: 'lock.fill', android: 'lock' },
  info: { ios: 'info.circle', android: 'info' },
  warning: { ios: 'exclamationmark.triangle', android: 'warning' },
  error: { ios: 'exclamationmark.circle', android: 'error' },
  offline: { ios: 'wifi.slash', android: 'wifi_off' },
  bell: { ios: 'bell', android: 'notifications' },
  bellFill: { ios: 'bell.fill', android: 'notifications_active' },
  handRaised: { ios: 'hand.raised.fill', android: 'back_hand' },
  sound: { ios: 'speaker.wave.2', android: 'volume_up' },
  repeat: { ios: 'repeat', android: 'repeat' },
  vibrate: { ios: 'iphone.radiowaves.left.and.right', android: 'vibration' },
  language: { ios: 'globe', android: 'language' },
  appearance: { ios: 'circle.lefthalf.filled', android: 'dark_mode' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  more: { ios: 'ellipsis', android: 'more_horiz' },
  layers: { ios: 'square.3.layers.3d', android: 'layers' },
  history: { ios: 'clock.arrow.circlepath', android: 'history' },
  star: { ios: 'star', android: 'star' },
  heart: { ios: 'heart', android: 'favorite' },
  school: { ios: 'graduationcap', android: 'school' },
  fitness: { ios: 'dumbbell', android: 'fitness_center' },
  cafe: { ios: 'cup.and.saucer', android: 'local_cafe' },
  shopping: { ios: 'cart', android: 'shopping_cart' },
  flight: { ios: 'airplane', android: 'flight' },
  straight: { ios: 'arrow.up', android: 'straight' },
  slightRight: { ios: 'arrow.up.right', android: 'turn_slight_right' },
  slightLeft: { ios: 'arrow.up.left', android: 'turn_slight_left' },
  turnRight: { ios: 'arrow.turn.up.right', android: 'turn_right' },
  turnLeft: { ios: 'arrow.turn.up.left', android: 'turn_left' },
  sharpRight: { ios: 'arrow.turn.right.up', android: 'turn_sharp_right' },
  sharpLeft: { ios: 'arrow.turn.left.up', android: 'turn_sharp_left' },
  uTurn: { ios: 'arrow.uturn.backward', android: 'u_turn_left' },
  roundabout: { ios: 'arrow.triangle.turn.up.right.circle', android: 'roundabout_right' },
  stairs: { ios: 'figure.stairs', android: 'stairs' },
  elevator: { ios: 'arrow.up.arrow.down.square', android: 'elevator' },
  escalator: { ios: 'figure.stairs', android: 'escalator' },
  enter: { ios: 'door.left.hand.open', android: 'door_open' },
  exit: { ios: 'rectangle.portrait.and.arrow.forward', android: 'logout' },
} as const satisfies Record<string, Glyph>;

/** Glyphs that point along the reading direction, resolved once: direction
 *  cannot change without a native restart, which reloads this module. */
const rtl = I18nManager.isRTL;
const DIRECTIONAL = {
  chevronForward: rtl
    ? { ios: 'chevron.left', android: 'chevron_left' }
    : { ios: 'chevron.right', android: 'chevron_right' },
  chevronBack: rtl
    ? { ios: 'chevron.right', android: 'chevron_right' }
    : { ios: 'chevron.left', android: 'chevron_left' },
  arrowForward: rtl
    ? { ios: 'arrow.left', android: 'arrow_back' }
    : { ios: 'arrow.right', android: 'arrow_forward' },
  arrowBack: rtl
    ? { ios: 'arrow.right', android: 'arrow_forward' }
    : { ios: 'arrow.left', android: 'arrow_back' },
} as const satisfies Record<string, Glyph>;

const ALL: Record<IconName, Glyph> = { ...GLYPHS, ...DIRECTIONAL };

export type IconName = keyof typeof GLYPHS | keyof typeof DIRECTIONAL;

export type IconProps = {
  name: IconName;
  /** A size token, or a number for the rare glyph sized to a shape (tab bar, map marker). */
  size?: IconSize | number;
  /** A colour role, or a literal colour (an operator colour's readable ink). */
  color?: ColorRole | (string & {});
  weight?: Extract<SymbolWeight, 'regular' | 'medium' | 'semibold' | 'bold'>;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function Icon({ name, size = 'md', color = 'textPrimary', weight = 'regular', style, accessibilityLabel }: IconProps) {
  const colors = useColors();
  const glyph = ALL[name];
  const px = typeof size === 'number' ? size : Size.icon[size];
  const tint = color in colors ? colors[color as ColorRole] : color;
  return (
    <SymbolView
      name={{ ios: glyph.ios, android: glyph.android, web: glyph.android }}
      size={px}
      tintColor={tint}
      weight={weight}
      style={[{ width: px, height: px }, style]}
      fallback={<View style={{ width: px, height: px }} />}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

/** The SF Symbol / Material Symbol pair for a name, for native APIs that take
 *  symbol names directly (native tabs, header toolbar). */
export function glyphFor(name: IconName): Glyph {
  return ALL[name];
}
