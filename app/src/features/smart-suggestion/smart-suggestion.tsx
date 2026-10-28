import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { MapSchemeScope } from '@/components/map-scheme-scope';
import { usePlanTrip } from '@/api/plan';
import type { PlanQuery } from '@/api/types';
import { DataCredit } from '@/components/data-credit';
import { LineBadge } from '@/components/line-badge';
import { Card, Glass, Icon, LeadingIcon, Loading, Radius, Space, Text, type ColorRole } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { firstTransitLeg, leaveState } from '@/features/results/itinerary-facts';
import { TripMap, type EdgePadding } from '@/features/results/trip-map';
import { LOCATION_ICON_NAMES } from '@/features/saved-locations/location-icons';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { useSearch } from '@/features/search/search-context';
import { useNow } from '@/hooks/use-now';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';
import { placeToQueryValue, type SelectedPlace } from '@/lib/place';

import { NearbySuggestion } from './nearby-suggestion';
import { resolveSmartTarget } from './resolve-smart-target';

/** The map is the card, so the card needs a height of its own -- there is
 *  no content in normal flow to give it one. Taller than the original 220:
 *  at 220 there was barely any road either side of the route, and the info
 *  panel now carries a countdown-sized line as well. */
const CARD_HEIGHT = 280;

/** Even breathing room on all four sides, so the route sits in the MIDDLE of
 *  the card rather than squeezed into the band above the panel. It is a
 *  preview, not a map to read: the panel covering its lower stretch costs
 *  nothing, while framing around that panel shrank the shape down to the top
 *  corner. A module constant, not a computed object: `TripMap` re-fits
 *  whenever this changes identity, and a fresh object per render would
 *  re-animate the fit on every tick of the countdown clock. */
const MAP_EDGE_PADDING: EdgePadding = {
  top: Space.xxl,
  right: Space.xxl,
  bottom: Space.xxl,
  left: Space.xxl,
};

/** The info panel's inset from the card's edge. With the card at `Radius.xl`
 *  and the panel at `Radius.lg`, this is what makes the two corners
 *  concentric (outer - inset = inner). */
const PANEL_INSET = Radius.xl - Radius.lg;

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
 * there simply isn't one. In that case, and again when the plan comes back
 * empty, the card stays and shows what is around the rider instead
 * (`NearbySuggestion`) -- a suggestion that has to apologise for itself is
 * worse than no suggestion, but the card itself is worth keeping.
 *
 * A hero card: the map clipped inside it (not behind it), with a glass panel
 * floating over its lower stretch that holds the text. The rider's three
 * questions in order -- where is this taking me, when do I move, what do I
 * catch.
 *
 * Painted in the map's scheme (`MapSchemeScope`): it sits on the map.
 */
export function SmartSuggestion({ onSelect }: SmartSuggestionProps) {
  return (
    <MapSchemeScope>
      <SmartSuggestionCard onSelect={onSelect} />
    </MapSchemeScope>
  );
}

function SmartSuggestionCard({ onSelect }: SmartSuggestionProps) {
  const { t, i18n } = useTranslation();
  const { timeFormat } = usePreferences();
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

  if (target === null) return <NearbySuggestion />;

  if (isLoading) {
    return (
      <Card variant="hero" padded={false} style={[styles.hero, styles.centered]}>
        <Loading />
      </Card>
    );
  }

  if (best === null) return <NearbySuggestion />;

  const icon = LOCATION_ICON_NAMES[target.preset === 'home' ? 'home' : 'briefcase'];
  const label = (target.preset === 'home' ? home?.label : work?.label) ?? '';

  const leave = leaveState(best.departureTime, now);
  const leaveLabel =
    leave.kind === 'departed'
      ? t('results.leaveDeparted')
      : leave.kind === 'now'
        ? t('results.leaveNow')
        // A clock-time rider gets "At 15:24" where the countdown would be.
        : leave.kind === 'countdown' && timeFormat === 'countdown'
          ? t('results.leaveIn', { count: leave.minutes })
          : t('results.leaveAt', { time: formatClockTime(best.departureTime) });
  // Green is the live, act-on-it state -- the moment the answer is "go", not
  // "soon". A countdown is plain text because it is information, not an
  // instruction, and a suggestion that has aged out goes quiet rather than
  // red: nothing has gone wrong, it just isn't the answer any more.
  const leaveColor: ColorRole =
    leave.kind === 'now' ? 'live' : leave.kind === 'departed' ? 'textSecondary' : 'textPrimary';

  const ride = firstTransitLeg(best);
  const detail = [
    ride?.from.stop.name?.trim() ?? '',
    t('results.arriveAt', { time: formatClockTime(best.arrivalTime) }),
    formatDurationMinutes(best.durationSeconds),
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return (
    <Card
      variant="hero"
      padded={false}
      onPress={() => onSelect(target.place)}
      accessibilityLabel={[label, leaveLabel, detail].join(', ')}
      style={styles.hero}
    >
      <TripMap itinerary={best} style={styles.map} edgePadding={MAP_EDGE_PADDING} monochrome showCredit={false} />

      {/* The map's own credit would sit under the panel; up here it is
          readable, and still on the map it is for. */}
      <DataCredit source="osm" variant="overlay" style={styles.credit} />

      {/* Glass, not a scrim: the panel holds the text against whatever the
          map draws under it, so the map itself needs no veil and stays the
          point of the card. Not interactive -- the whole card is the tap
          target, and a shimmer on just the panel would say otherwise. */}
      <Glass variant="regular" shape="rounded" style={styles.panel}>
        <View style={styles.identityRow}>
          <LeadingIcon>
            <Icon name={icon} size="sm" weight="medium" />
          </LeadingIcon>
          <Text variant="headline" numberOfLines={1} style={styles.grow}>
            {label}
          </Text>
          <Icon name="chevronForward" size="sm" color="textSecondary" weight="semibold" />
        </View>

        <Text variant="countdown" color={leaveColor} numberOfLines={1} adjustsFontSizeToFit>
          {leaveLabel}
        </Text>

        <View style={styles.rideRow}>
          {ride && <LineBadge route={ride.route} />}
          <Text variant="footnote" color="textSecondary" numeric numberOfLines={1} style={styles.detail}>
            {detail}
          </Text>
        </View>
      </Glass>
    </Card>
  );
}

const styles = StyleSheet.create({
  // `Card variant="hero"` already clips (`overflow: 'hidden'`) to its
  // `Radius.xl` corners, which is what cuts the map: it draws its own opaque
  // tiles and would otherwise square them off. No outline: drawing a line
  // around a map only announces where the tiles stop.
  hero: {
    height: CARD_HEIGHT,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  credit: {
    position: 'absolute',
    top: Space.sm,
    end: Space.sm,
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
  panel: {
    position: 'absolute',
    start: PANEL_INSET,
    end: PANEL_INSET,
    bottom: PANEL_INSET,
    borderRadius: Radius.lg,
    padding: Space.md,
    gap: Space.xs,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  grow: {
    flex: 1,
  },
  rideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  detail: {
    flexShrink: 1,
  },
});
