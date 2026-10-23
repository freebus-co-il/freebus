import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  EmptyState,
  Icon,
  Layout,
  ListRow,
  ListSection,
  Loading,
  SearchButton,
  Size,
  Sheet,
  Space,
  useColors,
} from '@/design-system';
import { JourneyDock, useJourneyDockInset } from '@/features/journey/journey-bar';
import { MapPickButton } from '@/features/map-picker/map-pick-button';
import { NearbyStops } from '@/features/nearby/nearby-stops';
import { Chip, SavedLocationChips } from '@/features/saved-locations/saved-location-chips';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import type { SavedLocation } from '@/features/saved-locations/types';
import { useSearch } from '@/features/search/search-context';
import { onSearchMorph, setSearchMorphOrigin, type MorphFrame } from '@/features/search/search-morph';
import { useDestinationNavigation } from '@/features/search/use-destination-navigation';
import { SmartSuggestion } from '@/features/smart-suggestion/smart-suggestion';
import { hapticWarned } from '@/lib/haptics';

/** iOS pads the first scroll view itself (status bar on top, the floating
 *  native tab bar below) through `contentInsetAdjustmentBehavior`; Android
 *  has no such adjustment, so the top inset is added by hand there. */
const IOS = Platform.OS === 'ios';

// No title: the "Where to?" capsule IS the top of the page. Still just the
// one prompt, not the results screen's full origin+destination+swap layout,
// and led by a search glyph rather than that panel's origin/destination
// markers: this is the entry point to a search, not a trip that already has
// both sides to show.
export default function SearchScreen() {
  const { t } = useTranslation();
  const searchRef = useRef<View>(null);
  const mapRef = useRef<View>(null);
  const chipsRef = useRef<View>(null);
  // While the picker draws these two controls in flight, their slots here
  // are held empty -- unmounted, not faded, since glass faded to nothing never
  // draws again. The chips under them are hidden too, while the picker's own
  // row rises from where they sit. Back on focus however the rider returns.
  const [controlsAway, setControlsAway] = useState(false);
  useEffect(() => onSearchMorph((event) => setControlsAway(event === 'out')), []);
  useFocusEffect(useCallback(() => setControlsAway(false), []));

  /** The capsule's frame goes with the rider into the picker, which grows its
   *  own search field out of it -- see `search-morph`. Measured at the tap, not
   *  on layout, because the page may have scrolled since. */
  function openSearch() {
    const node = searchRef.current;
    if (!node) {
      router.push('/location-picker');
      return;
    }
    const measure = (ref: RefObject<View | null>, then: (frame: MorphFrame | null) => void) => {
      if (!ref.current) then(null);
      else ref.current.measureInWindow((x, y, width, height) => then({ x, y, width, height }));
    };
    node.measureInWindow((x, y, width, height) => {
      const search = { x, y, width, height };
      // The map button rides along when there is one (not on web).
      measure(mapRef, (map) =>
        measure(chipsRef, (chips) => {
          setSearchMorphOrigin({ search, map, chips });
          router.push({ pathname: '/location-picker', params: { morph: '1' } });
        }),
      );
    });
  }

  const colors = useColors();
  const insets = useSafeAreaInsets();
  const dockInset = useJourneyDockInset();
  const savedLocations = useSavedLocations();
  const search = useSearch();
  // `push`, not the default `replace` -- a saved-location chip is tapped
  // directly on this screen with no transient search screen in between, so
  // `replace`ing here would replace HOME ITSELF (see this hook's own doc
  // comment): results would land with nothing underneath it on the stack,
  // and going back from it would fail outright.
  const { waitingForOrigin, originFailed, selectDestination } = useDestinationNavigation('push');
  const [actionsFor, setActionsFor] = useState<SavedLocation | null>(null);

  function selectSavedLocation(location: SavedLocation) {
    if (location.place) {
      selectDestination(location.place);
      return;
    }
    // An unset preset has no place to search FROM here -- send them to the
    // picker to assign one; the chip itself only ever starts a trip.
    router.push({ pathname: '/location-picker', params: { field: location.id === 'home' ? 'saved-home' : 'saved-work' } });
  }

  function editLocation(location: SavedLocation) {
    setActionsFor(null);
    if (location.isPreset) {
      router.push({ pathname: '/location-picker', params: { field: location.id === 'home' ? 'saved-home' : 'saved-work' } });
      return;
    }
    router.push({ pathname: '/location-picker', params: { field: 'saved-edit', editId: location.id } });
  }

  function removeLocation(location: SavedLocation) {
    // The one destructive action on this screen, and it happens with no
    // confirmation step -- the chip is simply gone. Worth feeling.
    hapticWarned();
    setActionsFor(null);
    savedLocations.removeCustom(location.id);
  }

  // Every state renders inside the same root so the journey dock is always
  // its LAST child -- it floats over the bottom of whatever is showing.
  function screen(content: ReactNode) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bgGrouped }]}>
        {content}
        <JourneyDock />
      </View>
    );
  }

  if (waitingForOrigin) {
    return screen(<Loading style={styles.centered} />);
  }

  // Every shortcut on this screen plans FROM where the rider is, so a failed
  // fix leaves nothing to plan from. Says so and offers the retry, instead of
  // leaving a spinner here forever: a new trip does not inherit the previous
  // trip's manually-picked origin, so this state is reachable.
  if (originFailed) {
    const state = search.originState;
    return screen(
      <View style={styles.centered}>
        <EmptyState
          icon="currentLocation"
          title={t(state.status === 'error' && state.message === 'location_permission_denied'
            ? 'search.locationPermissionDenied'
            : 'search.locationUnavailable')}
          action={{ label: t('search.retryLocation'), onPress: search.retryOrigin }}
        />
        {/* Retrying is only worth offering while a fix might still arrive.
            Naming a starting point is the way out when it will not -- it
            is what makes this screen a fork rather than a dead end. */}
        <Button
          variant="plain"
          label={t('search.chooseOrigin')}
          onPress={() =>
            router.push({ pathname: '/location-picker', params: { field: 'origin', andPlan: '1' } })
          }
        />
      </View>,
    );
  }

  return screen(
    <>
      {/* The page scrolls as ONE column -- search, shortcuts, the suggestion
          and the stations -- and this is the screen's first scroll view on
          purpose: native tabs on iOS find it to pad it for the floating tab
          bar and to minimise that bar on scroll. A tall suggestion card can
          push the stations down without either scrolling inside the other. */}
      <ScrollView
        style={styles.pageScroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.pageContent,
          !IOS && { paddingTop: insets.top + Space.lg },
          // Only the journey dock's room: the tab bar's own inset comes from
          // the automatic adjustment above (iOS) or the bar sitting outside
          // this screen's frame (Android).
          { paddingBottom: Layout.sectionGap + dockInset },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* The search capsule and the shortcut chips are one cluster -- how
            you leave this screen -- so they sit closer to each other than
            to the sections below. */}
        <View style={styles.cluster}>
          <View style={styles.searchRow}>
            {controlsAway ? (
              <>
                <View style={styles.searchSlot} />
                <View style={styles.mapSlot} />
              </>
            ) : (
              <>
                <SearchButton ref={searchRef} label={t('search.destinationPlaceholder')} onPress={openSearch} />
                <MapPickButton ref={mapRef} onPress={() => router.push('/map-picker')} />
              </>
            )}
          </View>

          {/* Hidden, not unmounted, while away: the row keeps its height, so
              nothing under it moves. Chips are solid, not glass, so they come
              back from opacity 0 fine. */}
          <View ref={chipsRef} collapsable={false} style={controlsAway && styles.away}>
          <SavedLocationChips
            locations={savedLocations.locations}
            onSelect={selectSavedLocation}
            onLongPress={setActionsFor}
            footer={
              <Chip
                icon="add"
                label={t('savedLocations.add')}
                muted
                onPress={() => router.push({ pathname: '/location-picker', params: { field: 'saved-new' } })}
              />
            }
          />
          </View>
        </View>

        {/* Above Nearby stops on purpose: an answer outranks a list of
            places to look. Renders nothing at all when there is no commute
            worth suggesting, so the list simply moves up. */}
        <SmartSuggestion onSelect={selectDestination} />

        <NearbyStops />
      </ScrollView>

      {/* The long-press actions for one saved place. The chip already fired
          the "long press recognised" haptic, which is what covers the beat
          before this sheet animates in. */}
      <Sheet
        visible={actionsFor !== null}
        onClose={() => setActionsFor(null)}
        title={actionsFor?.label}
        closeLabel={t('common.close')}
      >
        {actionsFor && (
          <ListSection variant="plain">
            <ListRow
              leading={<Icon name="edit" />}
              title={t('savedLocations.edit')}
              onPress={() => editLocation(actionsFor)}
            />
            {!actionsFor.isPreset && (
              <ListRow
                leading={<Icon name="delete" color="danger" />}
                title={t('savedLocations.remove')}
                destructive
                onPress={() => removeLocation(actionsFor)}
              />
            )}
          </ListSection>
        )}
      </Sheet>
    </>,
  );
}

const styles = StyleSheet.create({
  // The empty slots the search controls leave while they are in flight: the
  // same size, so nothing around them moves.
  searchSlot: {
    flex: 1,
    height: Size.control.md,
  },
  mapSlot: {
    width: Size.control.md,
    height: Size.control.md,
  },
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Layout.pageInset,
  },
  pageScroll: {
    flex: 1,
  },
  pageContent: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.sm,
    gap: Layout.sectionGap,
  },
  cluster: {
    gap: Space.lg,
  },
  away: { opacity: 0 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
});
