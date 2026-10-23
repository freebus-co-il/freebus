import { StyleSheet, View } from 'react-native';

import { Radius, Space, Text } from '@/design-system';
import { VehicleIcon } from '@/components/vehicle-icon';
import { readableTextColor, routeColor } from '@/lib/route-color';

export type LineBadgeRoute = {
  shortName: string | null;
  agencyId: string | null;
  type: number;
};

export type LineBadgeProps = {
  route: LineBadgeRoute;
  /** `small` for a dense strip (a stop's line list, a chip); `default` where a
   *  badge stands alone in a row; `large` as a screen's identity (a line page). */
  size?: 'small' | 'default' | 'large';
};

const SIZES = {
  small: { minWidth: 24, height: 18, pad: Space.xs, text: 'caption2', glyph: 11 },
  default: { minWidth: 32, height: 24, pad: Space.sm - Space.xxs, text: 'footnote', glyph: 14 },
  large: { minWidth: 44, height: 32, pad: Space.sm, text: 'headline', glyph: 18 },
} as const;

/**
 * One line, as an operator-coloured capsule with its number in it -- the app's
 * single vocabulary for "which line is this". The fill is the operator's colour,
 * so a strip of these groups by company before any number is read. Rail routes
 * have no number in this feed, so they show the vehicle glyph instead.
 */
export function LineBadge({ route, size = 'default' }: LineBadgeProps) {
  const color = routeColor(route);
  const ink = readableTextColor(color);
  const shortName = route.shortName?.trim() ?? '';
  const spec = SIZES[size];
  return (
    <View style={[styles.badge, { backgroundColor: color, minWidth: spec.minWidth, height: spec.height, paddingHorizontal: spec.pad }]}>
      {shortName === '' ? (
        <VehicleIcon type={route.type} size={spec.glyph} color={ink} />
      ) : (
        <Text variant={spec.text} emphasized numeric color={ink} numberOfLines={1}>
          {shortName}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: Radius.sm - Space.xxs, alignItems: 'center', justifyContent: 'center' },
});
