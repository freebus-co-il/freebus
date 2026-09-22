import { IconArrowsUpDown } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { usePlanTrip } from '@/api/plan';
import { IconBack } from '@/components/directional-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { groupItineraries } from '@/features/results/group-itineraries';
import { ModeFilterChip } from '@/features/results/mode-filter-chip';
import { TripCarousel } from '@/features/results/trip-carousel';
import { TripMap } from '@/features/results/trip-map';
import { ResultsEmptyState } from '@/features/results/results-empty-state';
import { itineraryPredictions } from '@/features/results/vehicle-markers';
import { useVehicles } from '@/api/vehicles';
import { useRecents } from '@/features/recents/recents-context';
import { useSearch } from '@/features/search/search-context';
import { TripTimePicker } from '@/features/search/trip-time-picker';
import { useTheme } from '@/hooks/use-theme';
import { placeCoordinates, placeLabel } from '@/lib/place';

export default function ResultsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { planQuery, origin, destination, swapOriginDestination } = useSearch();
  const { recordSearch } = useRecents();

  // Recorded when the search is ISSUED, not when results come back: a place
  // the rider looked up and found nothing for is still a place they looked
  // up, and is exactly the one they are most likely to try again. Keyed on
  // the query rather than on the place so an origin that arrives late (GPS)
  // records once, when it resolves, instead of on every unrelated re-render.
  //
  // The DESTINATION only. What is remembered is the search, not the journey:
  // the row hands this place back to the picker like any other result, and
  // plans afresh from wherever the rider is then. That is also why nothing
  // here has to name a live origin -- naming one would mean reverse-geocoding
  // a fix stamped "Current location" before it could be displayed, and none
  // of that is needed for a place the rider chose and which therefore
  // already has a name.
  const searchSignature = planQuery === null ? null : `${planQuery.from}>${planQuery.to}`;
  useEffect(() => {
    if (searchSignature === null || destination === null) return;
    recordSearch({ kind: 'search', place: destination });
    // `destination` is the object behind `searchSignature`, and
    // `recordSearch`'s identity changes on every recents state change (it
    // closes over `setState`), which would re-record on each save. The
    // signature is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSignature]);
  // Keyed by group signature rather than by position, so a chosen time is not
  // reassigned to a different trip when the groups shift under it, and resets
  // naturally whenever the itineraries themselves change (a new signature
  // simply isn't in here yet).
  const [activeTimeByGroup, setActiveTimeByGroup] = useState<Record<string, number>>({});
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);

  // Measured, not guessed -- both floating blocks wrap to however many lines
  // their content needs (the origin/destination card, a card with a risk
  // badge), so hardcoded padding would either frame the route underneath one
  // of them or over-crop it. `TripMap` re-fits whenever these change, so a
  // layout change here reframes the route automatically. Memoized so its
  // object identity is stable across unrelated re-renders -- `fitToItinerary`
  // depends on it, and a fresh object every render would re-run (and
  // re-animate) the fit on every render, not just on real changes.
  const [topBarHeight, setTopBarHeight] = useState(0);
  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  const mapEdgePadding = useMemo(
    () => ({
      top: topBarHeight + Spacing.three,
      right: 50,
      bottom: bottomBarHeight + Spacing.three,
      left: 50,
    }),
    [topBarHeight, bottomBarHeight],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = usePlanTrip(planQuery);
  // Soonest departure first, always. /plan returns its own order -- by RIDER
  // EFFORT: duration, walking priced above riding, a flat penalty per
  // interchange -- which is the right ranking for "which of these is the
  // nicest trip" and the wrong one for the question a rider standing at a
  // stop is actually asking, because it can lead with a journey that leaves
  // in an hour. A rider who wants the shorter, comfier trip can still swipe
  // to it; a rider who has missed the first card can't un-miss it.
  //
  // This is a display re-sort of the SAME fetched set, not a different search:
  // it never surfaces an itinerary /plan didn't already return.
  //
  // `departureTime` is the DOOR departure -- already net of the access walk --
  // so this ranks by when the rider has to start walking, which is what the
  // card's headline counts down to. Compared as strings, like
  // `groupItineraries` does for the departures inside one group: the API's
  // timestamps are a single fixed ISO-8601 format, so they order
  // lexicographically.
  const itineraries = [...(data?.itineraries ?? [])].sort((a, b) =>
    a.departureTime.localeCompare(b.departureTime),
  );
  // Groups collapse the SAME trip pattern appearing at several different
  // times into one card (see `groupItineraries`'s own doc comment) --
  // without this, the exact same walk+bus+walk shows up as one card per
  // scheduled departure instead of one card offering several departures.
  const groups = groupItineraries(itineraries);
  const selectedGroup = groups[selectedGroupIndex] ?? null;
  const selected = selectedGroup
    ? (selectedGroup.instances[activeTimeByGroup[selectedGroup.signature] ?? 0] ?? selectedGroup.instances[0] ?? null)
    : null;
  // The buses the card on screen rides, each counting down to the stop the
  // rider would board it at.
  const selectedTripIds = useMemo(
    () => (selected?.legs ?? []).flatMap((leg) => (leg.type === 'transit' ? [leg.tripId] : [])),
    [selected],
  );
  const { data: selectedLive } = useVehicles(selectedTripIds);
  const selectedPredictions = useMemo(() => itineraryPredictions(selected), [selected]);

  function selectGroupTime(groupIndex: number, group: (typeof groups)[number], timeIndex: number) {
    setSelectedGroupIndex(groupIndex);
    setActiveTimeByGroup((current) => ({ ...current, [group.signature]: timeIndex }));
  }

  // The bottom of the screen is never empty. While searching it says so; with
  // trips it shows them; and otherwise it says why there are none and offers
  // the one thing that moves the rider on -- the place the search is still
  // missing, or another go at it. A search that genuinely found nothing is
  // usually a time with no service (late at night, Shabbat), so that is what
  // it suggests changing, with the time chip right above the map to do it.
  const status = isLoading ? <ActivityIndicator /> : null;
  const emptyState = !destination
    ? {
        title: t('search.destinationPlaceholder'),
        body: t('results.emptyNoDestination'),
        actionLabel: t('results.chooseDestination'),
        onAction: () => router.push({ pathname: '/location-picker', params: { field: 'destination' } }),
      }
    : !origin
      ? {
          title: t('search.chooseOrigin'),
          body: t('results.emptyNoOrigin'),
          actionLabel: t('results.chooseOrigin'),
          onAction: () => router.push({ pathname: '/location-picker', params: { field: 'origin' } }),
        }
      : isError
        ? {
            title: t('results.error'),
            body: error instanceof ApiError ? error.message : t('results.errorHint'),
            actionLabel: t('results.refresh'),
            onAction: () => void refetch(),
          }
        : {
            title: t('results.noTrips'),
            body: t('results.noTripsHint'),
            actionLabel: t('results.refresh'),
            onAction: () => void refetch(),
          };

  return (
    <ThemedView type="background" style={styles.container}>
      {/* No `style` at all, so `TripMap`'s own `flex: 1` lays this out as an
          ordinary in-flow child -- which still fills the screen, because the
          two floating bars below are absolutely positioned and take no room
          in the flow. `StyleSheet.absoluteFill` renders identically but
          receives no touches whatsoever: the map could not be panned, zoomed
          or pinched. The trip screen's map, in flow with a height, is
          draggable -- this map is laid out the same way. */}
      <TripMap
        itinerary={selected}
        origin={origin ? placeCoordinates(origin) : null}
        destination={destination ? placeCoordinates(destination) : null}
        edgePadding={mapEdgePadding}
        vehicles={selectedLive?.vehicles}
        vehiclePredictions={selectedPredictions}
      />

      <SafeAreaView
        style={styles.topBar}
        edges={['top']}
        pointerEvents="box-none"
        onLayout={(event) => setTopBarHeight(event.nativeEvent.layout.height)}
      >
        <ThemedView type="background" style={styles.originDestCard}>
          <Pressable onPress={() => router.back()} style={styles.backButton} hitSlop={Spacing.two}>
            <IconBack size={20} color={theme.text} />
          </Pressable>

          <View style={styles.placesColumn}>
            <Pressable
              onPress={() => router.push({ pathname: '/location-picker', params: { field: 'origin' } })}
              style={styles.placeRow}
            >
              <View style={[styles.dot, { borderColor: theme.text }]} />
              <ThemedText type="smallBold" numberOfLines={1} style={styles.placeText}>
                {origin ? placeLabel(origin) : t('search.originPlaceholder')}
              </ThemedText>
            </Pressable>
            <View style={[styles.connector, { backgroundColor: theme.borderMuted }]} />
            <Pressable
              onPress={() => router.push({ pathname: '/location-picker', params: { field: 'destination' } })}
              style={styles.placeRow}
            >
              <View style={[styles.square, { backgroundColor: theme.text }]} />
              <ThemedText type="smallBold" numberOfLines={1} style={styles.placeText}>
                {destination ? placeLabel(destination) : t('search.destinationPlaceholder')}
              </ThemedText>
            </Pressable>
          </View>

          <Pressable
            onPress={swapOriginDestination}
            disabled={!origin || !destination}
            style={styles.swapButton}
            hitSlop={Spacing.two}
          >
            <IconArrowsUpDown size={18} color={origin && destination ? theme.text : theme.borderMuted} />
          </Pressable>
        </ThemedView>

        {/* The vehicle filter sits with the time picker rather than down by
            the results: both narrow the SEARCH, and the bottom of the screen is
            the answer, not more controls. Keeping it up here also means a
            filter that emptied the results stays reachable, next to the time
            the empty state below suggests changing. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.topChipScroll}
          contentContainerStyle={styles.topChipRow}
        >
          <TripTimePicker />
          <ModeFilterChip />
        </ScrollView>
      </SafeAreaView>

      {/* Floating over the map rather than sitting in a sheet that owns a
          fixed slice of the screen: the map is now full-bleed behind it, and
          this block is only ever as tall as its own content. */}
      <SafeAreaView
        style={styles.bottomBar}
        edges={['bottom']}
        pointerEvents="box-none"
        onLayout={(event) => setBottomBarHeight(event.nativeEvent.layout.height)}
      >
        {status ? (
          <ThemedView type="background" style={[styles.statusCard, { borderColor: theme.borderMuted }]}>
            {status}
          </ThemedView>
        ) : groups.length > 0 ? (
          <TripCarousel
            groups={groups}
            activeTimeByGroup={activeTimeByGroup}
            onActiveIndexChange={setSelectedGroupIndex}
            onSelectTime={selectGroupTime}
          />
        ) : (
          <ResultsEmptyState {...emptyState} busy={isFetching} />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: Spacing.two,
    gap: Spacing.three,
  },
  originDestCard: {
    marginHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.four,
  },
  backButton: {
    padding: Spacing.one,
  },
  placesColumn: {
    flex: 1,
    gap: Spacing.one,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  placeText: {
    flexShrink: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
  },
  square: {
    width: 7,
    height: 7,
    borderRadius: 2,
  },
  connector: {
    width: 1.5,
    height: 10,
    marginStart: 3,
  },
  swapButton: {
    padding: Spacing.one,
  },
  /** `flexGrow: 0` so the strip is only as tall as a chip -- a `ScrollView`
   *  in a column otherwise claims all the height left over, and this one
   *  floats over the map. */
  topChipScroll: {
    flexGrow: 0,
  },
  topChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
  statusCard: {
    alignItems: 'center',
    marginHorizontal: Spacing.three,
    padding: Spacing.four,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
  },
});
