import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { VehicleIcon } from '@/components/vehicle-icon';
import { Spacing } from '@/constants/theme';
import { readableTextColor, routeColor } from '@/lib/route-color';

export type LineBadgeRoute = {
  shortName: string | null;
  agencyId: string | null;
  type: number;
};

export type LineBadgeProps = {
  route: LineBadgeRoute;
  /** `small` for a dense strip of them (a stop's line list); `default`
   *  wherever one badge stands alone and is the thing being read. */
  size?: 'small' | 'default';
};

/**
 * One line, as a colour-filled capsule with its number in it.
 *
 * The app's single vocabulary for "which line is this" -- the departure
 * boards, the search results, the journey cards and the trip rail all draw
 * the same object, so a rider learns the shape once. The fill is the
 * OPERATOR's colour (see `lib/route-color`), which is what makes a strip of
 * these scannable: on a stop served by eight lines, the colours group them by
 * company before any number is read.
 *
 * Falls back to the vehicle glyph when a line has no number of its own --
 * every one of this feed's 1,071 rail routes, which would otherwise render
 * as an empty coloured capsule.
 */
export function LineBadge({ route, size = 'default' }: LineBadgeProps) {
  const color = routeColor(route);
  const textColor = readableTextColor(color);
  const shortName = route.shortName?.trim() ?? '';
  const small = size === 'small';

  return (
    <View style={[small ? styles.badgeSmall : styles.badge, { backgroundColor: color }]}>
      {shortName === '' ? (
        <VehicleIcon type={route.type} size={small ? 11 : 14} color={textColor} />
      ) : (
        <ThemedText type="smallBold" style={[{ color: textColor }, small && styles.textSmall]}>
          {shortName}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 34,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSmall: {
    minWidth: 24,
    paddingHorizontal: Spacing.one + 2,
    paddingVertical: 1,
    borderRadius: Spacing.one + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textSmall: {
    fontSize: 11,
    lineHeight: 15,
  },
});
