import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { usePlanTrip } from '@/api/plan';
import type { PlanQuery } from '@/api/types';
import { IconForward } from '@/components/directional-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { VehicleIcon } from '@/components/vehicle-icon';
import { Spacing } from '@/constants/theme';
import { firstTransitLeg, leaveState } from '@/features/results/itinerary-facts';
import { TripMap, type EdgePadding } from '@/features/results/trip-map';
import { LOCATION_ICON_COMPONENTS } from '@/features/saved-locations/location-icons';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { useSearch } from '@/features/search/search-context';
import { useNow } from '@/hooks/use-now';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';
import { placeToQueryValue, type SelectedPlace } from '@/lib/place';
import { readableTextColor, routeColor, UNKNOWN_OPERATOR_COLOR } from '@/lib/route-color';

import { resolveSmartTarget } from './resolve-smart-target';

/** The map is the card, so the card needs a height of its own -- there is
 *  no content in normal flow to give it one. 260 rather than the original
 *  220: at 220 there was barely any road either side of the route. */
const CARD_HEIGHT = 260;

/** The scrim's alpha ramp, as hex suffixes on the card's own surface colour:
 *  clear, then a little, then enough. The basemap under it is already muted
 *  (`monochrome` on `TripMap`), so this only has to win against the route
 *  line and the odd dark label rather than against full-colour cartography.
 *  These are the numbers to turn if a busy stretch of map ever beats the
 *  text -- raise the last stop first. */
const SCRIM_ALPHA = ['00', '80', 'E6'] as const;
/** How far up the card the veil reaches. Most of the way, so the ramp is
 *  gradual enough to have no visible edge -- a short scrim has to get steep
 *  to do the same job, and a steep ramp reads as a band drawn across the map. */
const SCRIM_HEIGHT = 172;

/** Even breathing room on all four sides, so the route sits in the MIDDLE of
 *  the card rather than squeezed into the band above the text. It is a
 *  preview, not a map to read: the text block covering its lower stretch
 *  costs nothing, while framing around that block shrank the shape down to
 *  the top corner. A module constant, not a computed object: `TripMap`
 *  re-fits whenever this changes identity, and a fresh object per render
 *  would re-animate the fit on every tick of the countdown clock. */
const MAP_EDGE_PADDING: EdgePadding = {
  top: Spacing.four,
  right: Spacing.four,
  bottom: Spacing.four,
  left: Spacing.four,
};

export type SmartSuggestionProps = {
  /** Starts the trip -- the home screen hands its own destination-selection
   *  flow down, so this card lands on results the same way a saved-location
   *  chip does. */
  onSelect: (place: SelectedPlace) => void;
};

/**
 * The one journey worth offering before being asked: the commute the rider is
 * most likely about to make, already planned, already drawn.
 *
 * Standing at home, that's the trip to work; anywhere else, it's the trip
 * home. `resolveSmartTarget` owns that decision and the conditions under which
 * there simply isn't one -- this component renders nothing at all in that
 * case, and nothing again when the plan comes back empty. A suggestion that
 * has to apologise for itself is worse than no suggestion.
 *
 * Structure follows NordVPN's connection card: a map contained in the card
 * (not behind it), fading into the card's own surface so the text below sits
 * on solid colour, led by a circular glyph, a name, and a coloured status
 * line. The rider's three questions in order -- where is this taking me, when
 * do I move, what do I catch.
 */
export function SmartSuggestion({ onSelect }: SmartSuggestionProps) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const now = useNow();
  const { originState } = useSearch();
  const savedLocations = useSavedLocations();

  // The raw GPS fix, not `useSearch().origin` -- the latter can be a manual
  // override left over from planning a trip, and "am I at home right now" is
  // a question only the device's own position can answer. Same reasoning as
  // `NearbyStops`.
  const here = originState.status === 'success' && originState.place.kind === 'coordinate'
    ? originState.place
    : null;

  const home = savedLocations.locations.find((location) => location.id === 'home') ?? null;
  const work = savedLocations.locations.find((location) => location.id === 'work') ?? null;
  const target = resolveSmartTarget(here, home?.place ?? null, work?.place ?? null);

  // Deliberately no time params (the backend's default is "now", which never
  // goes stale while the rider lingers here) and deliberately no `modes`: the
  // vehicle filter is a refinement of an explicit search, made on the results
  // screen and not even persisted across launches. Applying it to an
  // unprompted suggestion would hide the commute for a reason invisible from
  // this screen.
  const query: PlanQuery | null = here && target
    ? { from: placeToQueryValue(here), to: placeToQueryValue(target.place), lang: i18n.language }
    : null;
  const { data, isLoading } = usePlanTrip(query);
  // `/plan` already returns its results ranked by rider effort, so the first
  // one is the suggestion -- the same journey the results screen would put
  // in front of them.
  const best = data?.itineraries[0] ?? null;

  if (target === null) return null;

  if (isLoading) {
    return (
      <ThemedView type="background" style={[styles.hero, styles.centered]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  if (best === null) return null;

  const IconComponent = LOCATION_ICON_COMPONENTS[target.preset === 'home' ? 'home' : 'briefcase'];
  const label = (target.preset === 'home' ? home?.label : work?.label) ?? '';

  const leave = leaveState(best.departureTime, now);
  const leaveLabel =
    leave.kind === 'departed'
      ? t('results.leaveDeparted')
      : leave.kind === 'now'
        ? t('results.leaveNow')
        : leave.kind === 'countdown'
          ? t('results.leaveIn', { count: leave.minutes })
          : t('results.leaveAt', { time: formatClockTime(best.departureTime) });
  // Green is the live, act-on-it state -- the moment the answer is "go", not
  // "soon". A countdown is plain text because it is information, not an
  // instruction, and a suggestion that has aged out goes quiet rather than
  // red: nothing has gone wrong, it just isn't the answer any more.
  const leaveColor =
    leave.kind === 'now' ? 'success' : leave.kind === 'departed' ? 'textSecondary' : 'text';

  const ride = firstTransitLeg(best);
  const pillColor = ride ? routeColor(ride.route) : UNKNOWN_OPERATOR_COLOR;
  const rideShortName = ride?.route.shortName?.trim() ?? '';
  const detail = [
    ride?.from.stop.name?.trim() ?? '',
    t('results.arriveAt', { time: formatClockTime(best.arrivalTime) }),
    formatDurationMinutes(best.durationSeconds),
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return (
    <Pressable onPress={() => onSelect(target.place)}>
      <ThemedView type="background" style={styles.hero}>
        <TripMap itinerary={best} style={styles.map} edgePadding={MAP_EDGE_PADDING} monochrome />

        {/* Just enough veil to hold the text, and no more -- the map is the
            point. Ramps from zero rather than starting at the text's own
            edge, so there is no visible seam. Every stop is the page colour
            at a different alpha, never `transparent` (rgba(0,0,0,0)), which
            smears grey through the middle of the ramp on white -- same
            reasoning as `LegTimeline`'s fade. */}
        <LinearGradient
          colors={[
            `${theme.background}${SCRIM_ALPHA[0]}`,
            `${theme.background}${SCRIM_ALPHA[1]}`,
            `${theme.background}${SCRIM_ALPHA[2]}`,
          ]}
          locations={[0, 0.62, 1]}
          style={styles.scrim}
        />

        <View style={styles.body}>
          <View style={styles.identityRow}>
            <View style={[styles.iconCircle, { backgroundColor: theme.background }, outline]}>
              <IconComponent size={19} color={theme.text} />
            </View>
            <View style={styles.identityText}>
              <ThemedText type="default" numberOfLines={1}>
                {label}
              </ThemedText>
              <ThemedText type="smallBold" themeColor={leaveColor}>
                {leaveLabel}
              </ThemedText>
            </View>
            <IconForward
              size={18}
              color={theme.textSecondary}
            />
          </View>

          <View style={styles.rideRow}>
            {ride && (
              <View style={[styles.pill, { backgroundColor: pillColor }]}>
                {rideShortName === '' ? (
                  <VehicleIcon type={ride.route.type} size={14} color={readableTextColor(pillColor)} />
                ) : (
                  <ThemedText type="smallBold" style={{ color: readableTextColor(pillColor) }}>
                    {rideShortName}
                  </ThemedText>
                )}
              </View>
            )}
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.detail}>
              {detail}
            </ThemedText>
          </View>
        </View>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // A card again -- inset with the rest of the page -- but an UNOUTLINED
  // one. Drawing a line around a map only announces where the tiles stop,
  // which is the one thing a map does not need help saying; the corners
  // are enough to say where it ends.
  //
  // `overflow: 'hidden'` is what cuts the map to those corners: it draws
  // its own opaque tiles and would otherwise square them off.
  hero: {
    height: CARD_HEIGHT,
    borderRadius: Spacing.four,
    overflow: 'hidden',
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  map: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // The map is the card's backdrop, not a map to work with: a pannable
    // rectangle this small is a trap that swallows the tap meant for the card.
    pointerEvents: 'none',
  },
  scrim: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCRIM_HEIGHT,
  },
  body: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityText: {
    flex: 1,
  },
  rideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  pill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: 999,
  },
  detail: {
    flexShrink: 1,
  },
});
