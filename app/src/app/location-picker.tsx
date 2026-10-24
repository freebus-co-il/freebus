import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, Keyboard, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent, type TextInput } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { newGeocodeSession, resolvePlace, reverseGeocode, useAddressSearch } from '@/api/geocode';
import { useStopSearch } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { DataCredit } from '@/components/data-credit';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  GlassMorphLayer,
  GlassMorphShape,
  Icon,
  IconButton,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  Loading,
  Motion,
  Opacity,
  SearchHeader,
  Size,
  Space,
  Surface,
  Text,
  useColors,
  useReduceMotion,
} from '@/design-system';
import { takeMapPick } from '@/features/map-picker/map-pick-handoff';
import { RecentSearches } from '@/features/recents/recent-searches';
import { SavedLocationChips } from '@/features/saved-locations/saved-location-chips';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { LOCATION_ICON_NAMES } from '@/features/saved-locations/location-icons';
import type { SavedLocation } from '@/features/saved-locations/types';
import { useSearch } from '@/features/search/search-context';
import { emitSearchMorph, takeSearchMorphOrigin, type MorphFrame, type MorphOrigin } from '@/features/search/search-morph';
import { useDestinationNavigation } from '@/features/search/use-destination-navigation';
import { addressCredit } from '@/lib/attribution';
import { haversineMeters } from '@/lib/geo';
import type { SelectedPlace } from '@/lib/place';
import { placeToRouteParams } from '@/lib/place';

/** How long typing has to pause before `/stops/search` is hit. */
const SEARCH_DEBOUNCE_MS = 275;

/**
 * The same pause for `/geocode/search`, deliberately longer: stop search is
 * local and free, address search may be Google and billed per request. Every
 * pause mid-word that fires a request is a request paid for; stops still
 * appear at the snappier rate, and addresses join them a beat later.
 */
const ADDRESS_DEBOUNCE_MS = 450;

/**
 * Badges shown per stop before the rest collapse into a "+N".
 *
 * A search for a street name routinely returns eight stops with the same
 * name, and the lines calling at each are the only thing that tells them
 * apart -- so this has to be generous enough to actually discriminate. Six
 * fits one unwrapped row at the narrowest phone width; past that the row
 * would wrap and the list would stop scanning as a list.
 */
const MAX_LINE_BADGES = 6;

type Row =
  | {
    kind: 'stop'; key: string; stopId: string; title: string; lat: number; lon: number;
    /** The lines calling here -- what distinguishes eight stops that share a
     *  name. See `MAX_LINE_BADGES`. */
    routes: StopRouteBrief[];
    /** Which sign the row shows -- see `stationKindOf`. */
    rail: boolean;
    stationKind: string | undefined;
  }
  | {
    kind: 'address'; key: string; lat: number | null; lon: number | null;
    /** Set exactly when `lat`/`lon` aren't -- positioned on tap, in `selectRow`. */
    placeId: string | null; distanceMeters: number | null;
    title: string; subtitle: string | null;
  };

type Field = 'origin' | 'destination' | 'saved-home' | 'saved-work' | 'saved-new' | 'saved-edit';

/** How far a row is from `here`. An address with no position yet uses the
 *  distance the server measured from the same fix; one with neither sorts
 *  last rather than poisoning the comparator with NaN. */
function distanceFrom(here: { lat: number; lon: number }, row: Row): number {
  if (row.lat !== null && row.lon !== null) return haversineMeters(here, { lat: row.lat, lon: row.lon });
  return row.kind === 'address' && row.distanceMeters !== null ? row.distanceMeters : Number.MAX_SAFE_INTEGER;
}

export default function LocationPickerScreen() {
  const { t, i18n } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const morph = useSearchMorph();
  const search = useSearch();
  const savedLocations = useSavedLocations();
  // Absent entirely (not just falsy) only for the home screen's single
  // "Where to?" field -- that's the one entry point with no results screen
  // yet to go back to. `field=origin`/`field=destination` edit an existing
  // trip from the results screen's own rows; `field=saved-*` assigns a place
  // to a saved-location chip instead of today's trip at all. `editId` only
  // accompanies `field=saved-edit`, naming which custom location's place is
  // being reassigned (presets are identified by the field itself instead).
  // `q` pre-fills the search box: a caught share whose text matched several
  // addresses (or none) arrives here with what was shared already typed, so
  // the rider narrows it down instead of retyping it.
  const { field, editId, andPlan, q } = useLocalSearchParams<{ field?: Field; editId?: string; andPlan?: string; q?: string }>();
  const { waitingForOrigin, originFailed, selectDestination } = useDestinationNavigation();
  const isSavedFlow = field === 'saved-home' || field === 'saved-work' || field === 'saved-new' || field === 'saved-edit';
  // Shortcuts, not management: only the saved places that HAVE an address are
  // offered, since the unset ones exist here purely as a prompt to go set one
  // and this screen deliberately hands out no way to do that. Withheld from
  // the `saved-*` flows entirely -- those are assigning an address TO a saved
  // location, where offering the saved locations themselves is a circle.
  const savedShortcuts = isSavedFlow
    ? []
    : savedLocations.locations.filter((location) => location.place !== null);

  const [query, setQuery] = useState(q ?? '');
  // Seeded too, not left to the debounce: a pre-filled query is already
  // settled text, and waiting a beat before searching it would show the rider
  // an empty list under their own words.
  const [debouncedQuery, setDebouncedQuery] = useState(q ?? '');
  const [debouncedAddressQuery, setDebouncedAddressQuery] = useState(q ?? '');
  const [resolvingCurrentLocation, setResolvingCurrentLocation] = useState(false);
  // One address-search billing session per pick -- see `newGeocodeSession`.
  const [geocodeSession, setGeocodeSession] = useState(newGeocodeSession);
  /** The address row whose position is being fetched after a tap. */
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [resolveFailed, setResolveFailed] = useState(false);
  // Nothing to offer as "here" until the fix that defines it has arrived.
  const showCurrentLocation = !waitingForOrigin;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    const addressTimer = setTimeout(() => setDebouncedAddressQuery(query), ADDRESS_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(addressTimer);
    };
  }, [query]);

  const originState = search.originState;
  const here = originState.status === 'success' && originState.place.kind === 'coordinate'
    ? originState.place
    : null;

  const { data: stopData, isFetching: stopsFetching } = useStopSearch(debouncedQuery, i18n.language);
  const { data: addressData, isFetching: addressesFetching } = useAddressSearch(
    debouncedAddressQuery,
    i18n.language,
    { session: geocodeSession, near: here },
  );

  const unsortedRows: Row[] = [
    ...(stopData?.stops ?? []).map((s): Row => (
      {
        kind: 'stop', key: `stop:${s.stopId}`, stopId: s.stopId,
        title: s.name ?? s.stopId, lat: s.lat, lon: s.lon, routes: s.routes, rail: s.rail === true,
        stationKind: s.stationKind,
      }
    )),
    ...(addressData?.places ?? []).map((p, i): Row => (
      {
        kind: 'address', key: `address:${i}:${p.placeId ?? `${p.lat},${p.lon}`}`,
        lat: p.lat, lon: p.lon, placeId: p.placeId, distanceMeters: p.distanceMeters,
        title: p.label, subtitle: p.secondaryLabel,
      }
    )),
  ];
  // Only ranks by distance once we actually have a resolved GPS fix.
  // Anything else (denied, still loading, failed) keeps today's order:
  // stops before addresses, each in the backend's own relevance ranking.
  const rows = here
    ? [...unsortedRows].sort((a, b) => distanceFrom(here, a) - distanceFrom(here, b))
    : unsortedRows;
  // Counted from the rows actually listed, so the credit never outlives the
  // addresses it is for.
  const credit = addressCredit(addressData?.attribution, rows.filter((r) => r.kind === 'address').length);
  // Gate on the debounced query too, so nothing flashes "no matches" during
  // the pause before the requests go out.
  const showResults = debouncedQuery.trim().length >= 2 && query.trim().length >= 2;
  const isFetching = stopsFetching || addressesFetching;

  async function selectRow(row: Row) {
    if (row.kind === 'stop') {
      // Coordinates ride along even though `/plan` is queried by `stop:<id>`:
      // the results map needs somewhere to put the pin when a search returns
      // no journeys at all, and this is the only place they are in hand.
      commitPlace({ kind: 'stop', stopId: row.stopId, name: row.title, lat: row.lat, lon: row.lon });
      return;
    }

    let position = row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null;
    if (position === null && row.placeId !== null) {
      setResolvingKey(row.key);
      setResolveFailed(false);
      try {
        position = await resolvePlace(row.placeId, geocodeSession);
      } catch {
        position = null;
      } finally {
        setResolvingKey(null);
        // The pick closes this billing session whether or not it resolved.
        setGeocodeSession(newGeocodeSession());
      }
    }
    if (position === null) {
      setResolveFailed(true);
      return;
    }

    commitPlace({ kind: 'coordinate', lat: position.lat, lon: position.lon, label: row.title });
  }

  /** Where a picked place goes, and where the screen goes after it -- which
   *  depends entirely on who opened this picker and what they were doing.
   *  Separate from `selectRow` because a saved-location chip is already
   *  holding a `SelectedPlace` and has no result row to build one from. */
  function commitPlace(place: SelectedPlace) {
    if (field === 'origin') {
      search.setOriginOverride(place);
      // `andPlan` marks the origin picked BECAUSE the fix never came, with a
      // destination already chosen and waiting on it. Going `back` would
      // return to the screen that has nothing left to do -- the pending
      // selection there was cleared on blur -- so this goes forward to the
      // trip the rider was always asking for. Without the flag this is the
      // results screen's own origin row, and back is exactly right.
      if (andPlan) {
        router.replace('/results');
        return;
      }
      router.back();
      return;
    }

    if (field === 'saved-home' || field === 'saved-work') {
      savedLocations.setPreset(field === 'saved-home' ? 'home' : 'work', place);
      router.back();
      return;
    }

    if (field === 'saved-new') {
      // Replaces this screen rather than pushing on top -- `save-location`'s
      // own "back" then returns straight to the home screen, not here.
      router.replace({ pathname: '/save-location', params: placeToRouteParams(place) });
      return;
    }

    if (field === 'saved-edit') {
      if (editId) savedLocations.updateCustomPlace(editId, place);
      router.back();
      return;
    }

    if (field === 'destination') {
      // Editing an existing trip's destination from the results screen --
      // that screen reads `search.destination` live, so going back is enough.
      search.setDestination(place);
      router.back();
      return;
    }

    // The home screen's first-ever destination pick -- no results screen
    // exists yet to go back to, so wait for origin and create one.
    selectDestination(place);
  }

  // A place chosen on the map this picker opened, committed exactly as a
  // tapped row would be -- see `map-pick-handoff`. Through a ref so the focus
  // callback stays stable while `commitPlace` is new every render.
  const commitPlaceRef = useRef(commitPlace);
  useEffect(() => {
    commitPlaceRef.current = commitPlace;
  });
  useFocusEffect(
    useCallback(() => {
      const place = takeMapPick();
      if (place) commitPlaceRef.current(place);
    }, []),
  );

  // For the origin field, "current location" means clear any earlier
  // override and go back to live GPS tracking -- retried here too, in case
  // the last attempt failed, since picking this row is an explicit signal
  // the user wants GPS again. Every other mode instead means "use my
  // resolved GPS fix as the place", which needs that fix to actually exist
  // yet; tapping it before then just retries and waits rather than sending a
  // stale null through to `selectRow`.
  async function selectCurrentLocation() {
    if (field === 'origin') {
      search.setOriginOverride(null);
      search.retryOrigin();
      router.back();
      return;
    }

    if (!here) {
      search.retryOrigin();
      return;
    }

    // A saved location is permanent -- storing the literal string "Current
    // location" as its label would freeze in a name that's only ever true
    // at the moment it was saved, then reads as wrong (and confusingly
    // identical to a LIVE current-location origin) everywhere the rider
    // opens the app afterward. Reverse-geocode to a real address instead;
    // if that lookup comes back empty it is saved as a pinned location.
    let title = t('search.currentLocation');
    if (isSavedFlow) {
      // Not "Current location" even when the lookup fails: what gets saved is
      // where the rider stands NOW, a fixed point, and that label would read
      // as live tracking on every screen the place is shown afterwards.
      title = t('search.pinnedLocation');
      setResolvingCurrentLocation(true);
      try {
        const place = await reverseGeocode(here.lat, here.lon, i18n.language);
        if (place) title = place.label;
      } catch {
        // Keeps the pinned-location label set above.
      } finally {
        setResolvingCurrentLocation(false);
      }
    }

    await selectRow({
      kind: 'address',
      key: 'current-location',
      lat: here.lat,
      lon: here.lon,
      placeId: null,
      distanceMeters: null,
      title,
      subtitle: null,
    });
  }

  const originMessage = t(
    search.originState.status === 'error' && search.originState.message === 'location_permission_denied'
      ? 'search.locationPermissionDenied'
      : 'search.locationUnavailable',
  );

  return (
    <Surface level={morph.morphing ? undefined : 'bgGrouped'} style={styles.container}>
      {morph.morphing && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.bgGrouped }, morph.pageStyle]} />
      )}
      {/* No title: the field's own prompt ("Where to?", "Where from?") already
          says what this picker is for. The back button sits beside the field
          as one row of glass, the way a search screen reads on iOS 26. */}
      {/* Top inset from the hook, not `SafeAreaView`: presented transparent
          (the morph), the view reports no top inset and the field would sit
          under the status bar. */}
      <SafeAreaView edges={['bottom']} style={[styles.safeArea, { paddingTop: insets.top }]}>
        <View style={styles.top}>
          <SearchHeader
            ref={morph.inputRef}
            fieldHidden={morph.fieldHidden}
            backStyle={morph.backStyle}
            onBack={morph.goBack}
            backLabel={t('common.back')}
            // Focused once the morph lands, not while the capsule is still
            // flying: the keyboard rising mid-morph shoves the page around.
            autoFocus={!morph.active}
            placeholder={t(
              field === 'origin'
                ? 'search.originPlaceholder'
                : field?.startsWith('saved-')
                  ? 'search.savedLocationPlaceholder'
                  : 'search.destinationPlaceholder',
            )}
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              // A failed pick's message is about the list it was picked from.
              setResolveFailed(false);
            }}
            onClear={() => {
              setQuery('');
              setResolveFailed(false);
            }}
            clearLabel={t('common.clear')}
            // The way into choosing on the map, inside the field it is an
            // alternative to.
            trailing={(
              <IconButton
                icon="map"
                variant="plain"
                size="sm"
                accessibilityLabel={t('mapPicker.open')}
                onPress={() => {
                  Keyboard.dismiss();
                  router.push({ pathname: '/map-picker', params: { from: 'picker' } });
                }}
              />
            )}
          />

        </View>

        <View style={styles.body}>
        {/* Not faded with the rest of the page during the morph: the row
            rises from the home screen's own chips, drawn as they were there,
            and turns into this screen's row on the way (see `useSearchMorph`). */}
        <Animated.View style={[styles.chips, morph.chipsStyle]}>
          {/* "Current location" leads the same row as the saved shortcuts
              rather than sitting under it as a row of its own: the three are
              one kind of thing -- a place the rider can pick without typing
              -- and splitting them put a full-width row between the chips and
              the list for what is the shortest answer of the lot. First,
              because it needs no setting up and is the likeliest of them. */}
          {morph.chipsFlying ? (
            <ChipsFlight
              progress={morph.progress}
              locations={savedLocations.locations}
              currentLocationLabel={showCurrentLocation ? t('search.currentLocation') : null}
              addLabel={t('savedLocations.add')}
            />
          ) : (showCurrentLocation || savedShortcuts.length > 0) && (
            <SavedLocationChips
              locations={savedShortcuts}
              // Non-null by construction: `savedShortcuts` is filtered on it.
              onSelect={(location) => location.place && commitPlace(location.place)}
              leading={showCurrentLocation ? (
                <Chip
                  icon="currentLocation"
                  label={t('search.currentLocation')}
                  busy={resolvingCurrentLocation}
                  onPress={() => void selectCurrentLocation()}
                />
              ) : null}
            />
          )}
        </Animated.View>

        <Animated.View style={[styles.body, morph.contentStyle]}>

        {originFailed ? (
          <View style={styles.centered}>
            <EmptyState
              icon="currentLocation"
              title={originMessage}
              action={{ label: t('search.retryLocation'), onPress: search.retryOrigin }}
            />
            <Button
              variant="plain"
              size="md"
              label={t('search.chooseOrigin')}
              onPress={() =>
                router.push({ pathname: '/location-picker', params: { field: 'origin', andPlan: '1' } })
              }
              style={styles.centeredAction}
            />
          </View>
        ) : waitingForOrigin ? (
          <View style={styles.centered}>
            <Loading />
            {search.originState.status === 'error' && (
              <Pressable
                accessibilityRole="button"
                onPress={search.retryOrigin}
                android_ripple={{ color: colors.fillPressed }}
                style={({ pressed }) => [styles.retry, pressed && Platform.OS === 'ios' && { opacity: Opacity.pressed }]}
              >
                <Text variant="subheadline" color="textSecondary" align="center">
                  {originMessage}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            // The field above is autofocused, so the keyboard is up: the
            // default would spend the first tap on dismissing it and never
            // fire the row underneath.
            keyboardShouldPersistTaps="handled"
          >
            {resolveFailed && <Banner tone="danger" icon="error" title={t('search.placeUnavailable')} />}
            {/* At most eight stops and eight places (`limit: 8` each), so a
                plain group rather than a virtualised list. */}
            {showResults && rows.length > 0 && (
              <View style={styles.results}>
                <ListSection>
                  {rows.map((item) => (
                    <ListRow
                      key={item.key}
                      // Ignored rather than `disabled` while one address is
                      // being positioned: disabling would dim the whole list.
                      onPress={() => {
                        if (resolvingKey === null) void selectRow(item);
                      }}
                      leading={
                        item.key === resolvingKey ? (
                          <LeadingIcon>
                            <Loading style={styles.rowSpinner} />
                          </LeadingIcon>
                        ) : item.kind === 'stop' ? (
                          // A stop's sign is a square of its own, so it goes
                          // without the tile; the slot stays, keeping every
                          // row's text on one edge.
                          <StationIcon kind={stationKindOf(item)} />
                        ) : (
                          <LeadingIcon>
                            <Icon name="place" size="sm" weight="medium" />
                          </LeadingIcon>
                        )
                      }
                      title={item.title}
                      subtitle={
                        item.kind === 'address'
                          ? item.subtitle ?? undefined
                          : item.routes.length > 0
                            ? (
                              <View style={styles.lineRow}>
                                {item.routes.slice(0, MAX_LINE_BADGES).map((route) => (
                                  <LineBadge key={route.shortName} route={route} size="small" />
                                ))}
                                {item.routes.length > MAX_LINE_BADGES && (
                                  <Text variant="footnote" color="textSecondary" numeric>
                                    {t('search.moreLines', { count: item.routes.length - MAX_LINE_BADGES })}
                                  </Text>
                                )}
                              </View>
                            )
                            : undefined
                      }
                    />
                  ))}
                </ListSection>
                {credit && <DataCredit source={credit} />}
              </View>
            )}
            {showResults && !isFetching && rows.length === 0 && (
              <EmptyState icon="search" title={t('search.noMatches')} />
            )}
            {/* What fills this screen before the rider types. Gated on
                `showResults` rather than on `query`, so it does not blink
                out during the debounce pause and back in again when a
                one-character query turns out not to search anything.
                Straight into `commitPlace`, exactly where a tapped search
                result ends up -- which is what lets these rows stand in
                every mode this screen has. As a destination, as an origin,
                or as the address being pinned to a saved location,
                somewhere the rider looked up before is a reasonable answer,
                and each mode already knows what to do with a place. */}
            {!showResults && <RecentSearches onSelect={commitPlace} />}
          </ScrollView>
        )}
        </Animated.View>
        </View>
      </SafeAreaView>
      {morph.overlay(
        t(
          field === 'origin'
            ? 'search.originPlaceholder'
            : field?.startsWith('saved-')
              ? 'search.savedLocationPlaceholder'
              : 'search.destinationPlaceholder',
        ),
      )}
    </Surface>
  );
}

/**
 * The chips row in flight, turning from the home screen's row into this
 * screen's as `progress` runs 0 to 1 (and back). Home's row has every saved
 * place and "Add"; this screen's leads with "Current location" and keeps only
 * the places with an address. So every chip slides from where it sits in
 * home's row to where it sits in this one, all together as one row; the ones
 * only home has slide along with their neighbours and fade; and "Current
 * location" slides in from the start edge to lead the row. Both ends match
 * the real rows exactly, so neither hand-over shows.
 *
 * A plain row, not the shared `SavedLocationChips`: that one scrolls, and a
 * scroll view clips whatever slides in from beyond its edge.
 */
function ChipsFlight({ progress, locations, currentLocationLabel, addLabel }: {
  progress: SharedValue<number>;
  locations: SavedLocation[];
  /** Null while there is no fix to offer as "here" (the row has no lead). */
  currentLocationLabel: string | null;
  addLabel: string;
}) {
  // Each chip's width, from layout: the slide distances are built from them.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const measure = (id: string) => (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setWidths((known) => (known[id] === width ? known : { ...known, [id]: width }));
  };
  const leadWidth = currentLocationLabel ? (widths[LEAD_ID] ?? 0) : 0;
  // How far toward the end every chip moves to make room for the lead.
  const leadRoom = currentLocationLabel ? leadWidth + Space.sm : 0;

  const chips = [
    ...locations.map((location) => ({ id: location.id, location, stays: location.place !== null })),
    { id: ADD_ID, location: null, stays: false },
  ];
  let goneBefore = 0;
  let lastStayingShift = leadRoom;
  return (
    <View pointerEvents="none" style={styles.flightRow}>
      {chips.map(({ id, location, stays }) => {
        // A chip that stays closes up behind the leaving ones: it moves back
        // by the room every leaving chip before it took. A leaving chip
        // travels with the staying chip in front of it, so the leavers move as
        // one block with it and never slide into each other.
        let shift = lastStayingShift;
        if (stays) {
          shift = leadRoom - goneBefore;
          lastStayingShift = shift;
        } else {
          goneBefore += (widths[id] ?? 0) + Space.sm;
        }
        return (
          <FlightChip key={id} progress={progress} shift={shift} fades={!stays} onLayout={measure(id)}>
            {location ? (
              <Chip
                icon={LOCATION_ICON_NAMES[location.icon]}
                label={location.label}
                filled={location.place !== null}
                muted={location.place === null}
                onPress={() => {}}
              />
            ) : (
              <Chip icon="add" label={addLabel} muted onPress={() => {}} />
            )}
          </FlightChip>
        );
      })}
      {currentLocationLabel && (
        <LeadChip progress={progress} width={leadWidth} onLayout={measure(LEAD_ID)}>
          <Chip icon="currentLocation" label={currentLocationLabel} onPress={() => {}} />
        </LeadChip>
      )}
    </View>
  );
}

const LEAD_ID = '__current-location';
const ADD_ID = '__add';
/** Toward the row's end, in physical x: left under RTL. */
const END_X = I18nManager.isRTL ? -1 : 1;

function FlightChip({ progress, shift, fades, onLayout, children }: {
  progress: SharedValue<number>;
  shift: number;
  fades: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const p = progress.get();
    return {
      transform: [{ translateX: END_X * shift * p }],
      // Gone by mid-flight, so a leaving chip is never seen under one that
      // slides over the place it had.
      opacity: fades ? Math.max(0, 1 - p * 2) : 1,
    };
  });
  return (
    <Animated.View onLayout={onLayout} style={style}>
      {children}
    </Animated.View>
  );
}

function LeadChip({ progress, width, onLayout, children }: {
  progress: SharedValue<number>;
  width: number;
  onLayout: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  // From just beyond the screen's start edge to the head of the row.
  const offscreen = width + Layout.pageInset;
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: -END_X * offscreen * (1 - progress.get()) }],
  }));
  return (
    <Animated.View onLayout={onLayout} style={[styles.flightLead, style]}>
      {children}
    </Animated.View>
  );
}

/** The box the flying map glyph is centred in: the larger of its two sizes. */
const MORPH_GLYPH_BOX = Size.icon.md;

const styles = StyleSheet.create({
  morphRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.lg,
  },
  morphLabel: {
    flex: 1,
  },
  morphCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  flightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  flightLead: {
    position: 'absolute',
    start: 0,
  },
  morphGlyph: {
    position: 'absolute',
    width: MORPH_GLYPH_BOX,
    height: MORPH_GLYPH_BOX,
  },
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  top: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.sm,
  },
  body: {
    flex: 1,
  },
  chips: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.md,
  },

  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.xxl,
    paddingBottom: Layout.sectionGap,
    gap: Layout.sectionGap,
  },
  results: {
    gap: Space.md,
  },
  // `Loading` centres itself in padding meant for a page; in a row's tile it
  // has only the tile to fill.
  rowSpinner: {
    paddingVertical: Space.none,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Layout.pageInset,
  },
  centeredAction: {
    alignSelf: 'center',
  },
  retry: {
    paddingHorizontal: Layout.pageInset,
  },
});

/**
 * The home screen's search capsule growing into this screen's field -- the
 * iOS 26 glass morph, for the one hand-off where both ends are ours. See
 * `search-morph` for how the frame arrives.
 *
 * A glass capsule is drawn where the home capsule was and springs to where the
 * field sits, while the back button and the page fade in under it; the real
 * field takes over (and the keyboard rises) once it lands. Back runs it in
 * reverse before leaving. Opened any other way, or with Reduce Motion on, none
 * of this happens and the picker simply appears.
 */
function useSearchMorph() {
  const [origin] = useState<MorphOrigin | null>(() => takeSearchMorphOrigin());
  const reduceMotion = useReduceMotion();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // `active`: the flight stands in for the field (the field is not mounted).
  const [active, setActive] = useState(origin !== null);
  // Whether the flight is drawn. Glass is see-through, so the home screen's
  // controls, the flight and the field must never be on screen together:
  // every hand-over happens inside ONE synchronous step, which React commits
  // as one frame.
  const [flying, setFlying] = useState(false);
  const progress = useSharedValue(origin ? 0 : 1);
  const inputRef = useRef<TextInput>(null);

  // Where the field sits, worked out rather than measured: measuring mid-
  // transition returned frames from before the safe-area inset applied. The
  // header's geometry is fixed -- page inset, back button, gap -- so the
  // field's frame follows from it. Physical x, like the origin.
  const field: MorphFrame = {
    x: I18nManager.isRTL ? Layout.pageInset : Layout.pageInset + Size.control.md + Space.sm,
    y: insets.top + Space.sm,
    width: windowWidth - Layout.pageInset * 2 - Size.control.md - Space.sm,
    height: Size.control.md,
  };
  // The field's own map button: a small circle at its end edge.
  const mapSize = Size.control.sm;
  const mapSlot: MorphFrame = {
    x: I18nManager.isRTL ? field.x + Space.xs : field.x + field.width - Space.xs - mapSize,
    y: field.y + (field.height - mapSize) / 2,
    width: mapSize,
    height: mapSize,
  };

  // The flight has landed on the field: the field mounts and the flight goes,
  // in one commit. The field's `autoFocus` then raises the keyboard.
  const land = () => {
    progress.set(1);
    setActive(false);
  };

  // The morph runs once, as the screen arrives: home empties its slots and the
  // flight appears at the home controls' frames in the same commit.
  useEffect(() => {
    if (!origin) return;
    const frame = requestAnimationFrame(() => {
      emitSearchMorph('out');
      if (reduceMotion) {
        land();
        return;
      }
      setFlying(true);
      progress.set(withSpring(1, Motion.morph, (finished) => {
        if (finished) scheduleOnRN(land);
      }));
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function leave() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  // The flight is back on the home screen's controls: they return and the
  // flight goes, in the same commit, as the picker lifts away.
  function arriveHome() {
    emitSearchMorph('back');
    setFlying(false);
    leave();
  }

  function goBack() {
    Keyboard.dismiss();
    if (!origin || reduceMotion) {
      leave();
      return;
    }
    // The field gives way to the flight in one commit (see `flying`).
    setActive(true);
    progress.set(withSpring(0, Motion.morph, (finished) => {
      if (finished) scheduleOnRN(arriveHome);
    }));
  }

  // Absolute positions run from the reading edge under RTL, while frames are
  // physical x -- so a shape's start offset is measured from the right in
  // Hebrew. Plain numbers, worked out here: the styles below run on the UI
  // thread, where only worklets and captured values exist.
  const box = (frame: MorphFrame) => ({
    start: I18nManager.isRTL ? windowWidth - frame.x - frame.width : frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
  });
  const searchFrom = origin ? box(origin.search) : box(field);
  const searchTo = box(field);
  const mapFrom = origin?.map ? box(origin.map) : box(mapSlot);
  const mapTo = box(mapSlot);

  const searchStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const mix = (from: number, to: number) => from + (to - from) * p;
    return {
      start: mix(searchFrom.start, searchTo.start),
      top: mix(searchFrom.top, searchTo.top),
      width: mix(searchFrom.width, searchTo.width),
      height: mix(searchFrom.height, searchTo.height),
    };
  });
  // The map button is absorbed by the capsule as it stretches over it: the
  // glass circle stays put and shrinks ahead of the capsule's near edge, gone
  // by the time the edge reaches its centre -- and grows back out of it on the
  // way back. Never under the capsule: glass on glass reads as two layers.
  const mapCenter = { start: mapFrom.start + mapFrom.width / 2, top: mapFrom.top + mapFrom.height / 2 };
  const mapRadius = mapFrom.width / 2;
  const mapAfterSearch = mapCenter.start > searchFrom.start;
  const mapStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const mix = (from: number, to: number) => from + (to - from) * p;
    const start = mix(searchFrom.start, searchTo.start);
    const width = mix(searchFrom.width, searchTo.width);
    const room = mapAfterSearch ? mapCenter.start - (start + width) : start - mapCenter.start;
    const r = Math.min(mapRadius, Math.max(0, room));
    return { start: mapCenter.start - r, top: mapCenter.top - r, width: r * 2, height: r * 2 };
  });
  // The map glyph is not glass, so it flies on its own, above the capsule,
  // from the home button's centre into the field's map button.
  const mapGlyphStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const mix = (from: number, to: number) => from + (to - from) * p;
    return {
      start: mix(mapCenter.start, mapTo.start + mapTo.width / 2) - MORPH_GLYPH_BOX / 2,
      top: mix(mapCenter.top, mapTo.top + mapTo.height / 2) - MORPH_GLYPH_BOX / 2,
    };
  });
  // The chips row rises from the home screen's chips to its place under the
  // field. Worked out like the field's frame: the row starts a fixed gap
  // under it.
  const chipsShift = origin?.chips ? origin.chips.y - (field.y + field.height + Space.md) : 0;
  const chipsStyle = useAnimatedStyle(() => ({ transform: [{ translateY: chipsShift * (1 - progress.get()) }] }));
  const contentStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));
  const fromStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.get() }));
  const toStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));
  // The page itself, faded in behind everything: the picker is presented
  // transparent over the home screen when it morphs.
  const pageStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));
  // Never fully transparent: glass inside a view at opacity 0 stops rendering
  // and does not come back (see `Glass`).
  const backStyle = useAnimatedStyle(() => ({
    opacity: 0.05 + 0.95 * progress.get(),
    transform: [{ scale: 0.6 + 0.4 * progress.get() }],
  }));

  return {
    active,
    inputRef,
    progress,
    chipsStyle,
    // The chips row is drawn by `ChipsFlight` for as long as the field is.
    chipsFlying: active && origin?.chips != null,
    goBack,
    contentStyle,
    backStyle,
    morphing: origin !== null,
    pageStyle,
    // The real field mounts when the flight lands -- see `fieldHidden`.
    fieldHidden: active && origin !== null,
    overlay: (placeholder: string) =>
      active && flying && origin ? (
        <>
        <GlassMorphLayer>
          <GlassMorphShape style={searchStyle}>
            <View style={styles.morphRow}>
              {/* Drawn exactly like Home's capsule and the glass field, which
                  match each other, so neither end of the flight snaps. */}
              <Icon name="search" size="md" weight="medium" />
              <Text variant="body" color="textSecondary" numberOfLines={1} style={styles.morphLabel}>
                {placeholder}
              </Text>
            </View>
          </GlassMorphShape>
          {origin.map && <GlassMorphShape shape="circle" style={mapStyle} />}
        </GlassMorphLayer>
        {origin.map && (
          <Animated.View pointerEvents="none" style={[styles.morphGlyph, mapGlyphStyle]}>
            <Animated.View style={[StyleSheet.absoluteFill, styles.morphCenter, fromStyle]}>
              <Icon name="map" size="md" weight="medium" />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, styles.morphCenter, toStyle]}>
              <Icon name="map" size="sm" weight="medium" />
            </Animated.View>
          </Animated.View>
        )}
        </>
      ) : null,
  };
}
