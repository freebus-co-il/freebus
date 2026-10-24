import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { GLASS_SUPPORTED, Icon, Radius, Size, Space, Text, useColors } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { readableTextColor, routeColor } from '@/lib/route-color';

import { useJourney } from './journey-context';
import { journeyCopy, vehicleInPlay } from './journey-copy';

/** Thin enough to read as an edge the bar happens to have rather than a
 *  control, which keeps the whole bar the tap target. */
const RAIL_HEIGHT = 2;

/** The classic (pre-iOS 26) tab bar height, above the home indicator. */
const CLASSIC_TAB_BAR_HEIGHT = 49;

/** iOS 26+: the journey rides in the tab bar's own accessory slot. */
export const USES_TAB_ACCESSORY = GLASS_SUPPORTED;

function useJourneyBarModel() {
  const { journey, state } = useJourney();
  const { t } = useTranslation();
  const colors = useColors();
  const { timeFormat } = usePreferences();
  if (!journey || !state) return null;
  const ride = vehicleInPlay(journey.itinerary, state);
  const copy = journeyCopy(state, journey.itinerary, journey.destinationLabel, t, {
    end: colors.textPrimary,
    alert: colors.danger,
  }, timeFormat);
  // Where the screen renders the way out as a control, the bar only names it:
  // a second tap target in a docked bar is how a stressed rider mis-taps.
  const supporting = copy.action ?? copy.supporting;
  return { ride, hero: copy.hero, supporting, progress: state.progress };
}

function Content({ compact }: { compact: boolean }) {
  const model = useJourneyBarModel();
  const colors = useColors();
  if (!model) return null;
  const { ride, hero, supporting, progress } = model;
  const fill = ride ? routeColor(ride.route) : colors.walk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={supporting === null ? hero : `${hero}. ${supporting}`}
      onPress={() => router.navigate('/journey')}
      style={[styles.row, compact && styles.rowCompact]}
    >
      {ride ? (
        <LineBadge route={ride.route} size={compact ? 'small' : 'default'} />
      ) : (
        <View style={[styles.walkBadge, compact && styles.walkBadgeSmall, { backgroundColor: colors.walk }]}>
          <Icon name="walk" size={compact ? 11 : 14} color={readableTextColor(colors.walk)} />
        </View>
      )}
      <View style={styles.lines}>
        <Text variant={compact ? 'footnote' : 'subheadline'} emphasized numberOfLines={1}>
          {hero}
        </Text>
        {!compact && supporting !== null && (
          <Text variant="footnote" color="textSecondary" numberOfLines={1}>
            {supporting}
          </Text>
        )}
      </View>
      {/* Two flexed children, so the fill grows from the reading edge in both
          directions -- `row` is what RTL flips for free. */}
      <View style={[styles.rail, compact && styles.railCompact]} pointerEvents="none">
        <View style={{ flex: progress, backgroundColor: fill }} />
        <View style={{ flex: 1 - progress }} />
      </View>
    </Pressable>
  );
}

/**
 * The live journey, docked to the tab bar on every tab and one tap from its
 * full screen -- a media player's mini-bar for a bus ride.
 *
 * iOS 26 only: the content of `<NativeTabs.BottomAccessory>`. The accessory
 * element has to be a DIRECT child of `<NativeTabs>` (it is found by type), so
 * the layout renders it and this is only what goes inside. Glass comes from the
 * system; the content goes compact when the bar minimises on scroll.
 */
export function JourneyAccessoryContent() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return <Content compact={placement === 'inline'} />;
}

/** Whether the tab bar should show the journey accessory right now. */
export function useJourneyAccessoryVisible(): boolean {
  const model = useJourneyBarModel();
  return USES_TAB_ACCESSORY && model !== null;
}

/**
 * The same bar where the tab bar has no accessory slot (Android, iOS < 26).
 * Render it as the LAST child of a tab root: on Android it sits in flow just
 * above the navigation bar; on older iOS it floats above the classic tab bar.
 */
export function JourneyDock() {
  const model = useJourneyBarModel();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  if (USES_TAB_ACCESSORY || !model) return null;
  return (
    <View
      style={[
        styles.dock,
        { backgroundColor: colors.surfaceFloating, borderColor: colors.separator },
        Platform.OS === 'ios' && { position: 'absolute', start: 0, end: 0, bottom: insets.bottom + CLASSIC_TAB_BAR_HEIGHT },
      ]}
    >
      <Content compact={false} />
    </View>
  );
}

/** The height a scrolling tab root should leave free at its end for the dock. */
export function useJourneyDockInset(): number {
  const model = useJourneyBarModel();
  if (USES_TAB_ACCESSORY || !model) return 0;
  return Size.row.min + Space.sm;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingTop: Space.sm,
    paddingBottom: Space.sm + RAIL_HEIGHT,
    minHeight: Size.row.min,
  },
  rowCompact: { paddingHorizontal: Space.md, paddingTop: 0, paddingBottom: 0, gap: Space.sm, minHeight: 0, flex: 1 },
  lines: { flex: 1 },
  walkBadge: {
    minWidth: 32,
    height: 24,
    paddingHorizontal: Space.sm - Space.xxs,
    borderRadius: Radius.sm - Space.xxs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  walkBadgeSmall: { minWidth: 24, height: 18 },
  rail: { position: 'absolute', start: 0, end: 0, bottom: 0, height: RAIL_HEIGHT, flexDirection: 'row' },
  railCompact: { start: Space.md, end: Space.md },
  dock: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
});
