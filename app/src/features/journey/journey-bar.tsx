import { IconWalk } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { IconForward } from '@/components/directional-icon';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { readableTextColor, routeColor, WALK_LEG_COLOR } from '@/lib/route-color';

import { useJourney } from './journey-context';
import { journeyCopy, vehicleInPlay } from './journey-copy';

/** Thin enough to read as an edge the bar happens to have rather than as a
 *  control, which is what keeps the tap target the whole bar. */
const RAIL_HEIGHT = 2;

/** Matches `LineBadge`'s own glyph size, so the walk capsule and a route
 *  capsule are the same object wearing a different colour. */
const WALK_GLYPH_SIZE = 14;

/**
 * The now-playing dock: the running journey, docked above the tab bar on every
 * tab, always one tap from its full screen.
 *
 * Borrowed wholesale from a media player's mini-bar (see the spec). The
 * journey outlives the screen that started it, so the rider can search
 * something else, walk into another tab, or close the app entirely and still
 * have it exactly where they left it.
 *
 * Flat by rule (`AGENTS.md`): a hairline top border and the element surface
 * are the whole separation, which is exactly how the tab bar underneath
 * separates itself. A docked bar is where the temptation to lift it off the
 * page is strongest, and lifting it would make it the one thing on screen
 * pretending to float.
 */
export function JourneyBar() {
  const { journey, state } = useJourney();
  const { t } = useTranslation();
  const theme = useTheme();

  // Nothing running is the common case, and it must cost the tab bar nothing.
  if (!journey || !state) return null;

  const ride = vehicleInPlay(journey.itinerary, state);
  const color = ride ? routeColor(ride.route) : WALK_LEG_COLOR;
  const copy = journeyCopy(state, journey.itinerary, journey.destinationLabel, t, {
    end: theme.text,
    alert: theme.danger,
  });
  const { hero } = copy;
  // Where the screen renders the way out as a control, the bar only names
  // it: a second tap target inside a docked bar is how a stressed rider
  // mis-taps, and the whole bar already leads to the screen that offers it.
  const supporting = copy.action ?? copy.supporting;

  return (
    <ThemedView type="background" style={[styles.bar, { borderTopColor: theme.borderMuted }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={supporting === null ? hero : `${hero}. ${supporting}`}
        onPress={() => router.navigate('/journey')}
        style={styles.pressable}
      >
        {ride ? (
          <LineBadge route={ride.route} />
        ) : (
          <View style={[styles.walkBadge, { backgroundColor: WALK_LEG_COLOR }]}>
            <IconWalk size={WALK_GLYPH_SIZE} color={readableTextColor(WALK_LEG_COLOR)} />
          </View>
        )}

        <View style={styles.lines}>
          <ThemedText type="defaultBold" numberOfLines={1}>
            {hero}
          </ThemedText>
          {supporting !== null && (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              {supporting}
            </ThemedText>
          )}
        </View>

        <IconForward
          size={18}
          color={theme.textSecondary}
        />
      </Pressable>

      {/* A row of two flexed children rather than an absolutely positioned
          width, so the fill grows from the reading edge in both directions --
          `flexDirection: 'row'` is the one thing RTL flips for free. */}
      <View style={styles.rail} pointerEvents="none">
        <View style={{ flex: state.progress, backgroundColor: color }} />
        <View style={{ flex: 1 - state.progress }} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  pressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    // Keeps the rail's own height out of the text's breathing room, so the
    // two lines sit optically centred rather than pushed up off the edge.
    paddingBottom: Spacing.two + RAIL_HEIGHT,
  },
  lines: {
    flex: 1,
  },
  // The same capsule `LineBadge` draws, for the stretches of the journey that
  // have no vehicle to name -- the final walk, and arrival.
  walkBadge: {
    minWidth: 34,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rail: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: RAIL_HEIGHT,
    flexDirection: 'row',
  },
});
