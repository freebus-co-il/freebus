import { IconCurrentLocation, IconMapPin, IconSearch } from '@tabler/icons-react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { newGeocodeSession, resolvePlace, reverseGeocode, useAddressSearch } from '@/api/geocode';
import { useStopSearch } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { IconBack } from '@/components/directional-icon';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { MapPickButton } from '@/features/map-picker/map-pick-button';
import { takeMapPick } from '@/features/map-picker/map-pick-handoff';
import { RecentSearches } from '@/features/recents/recent-searches';
import { Chip, SavedLocationChips } from '@/features/saved-locations/saved-location-chips';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { FieldShell } from '@/features/search/field-shell';
import { useSearch } from '@/features/search/search-context';
import { useDestinationNavigation } from '@/features/search/use-destination-navigation';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { haversineMeters } from '@/lib/geo';
import type { SelectedPlace } from '@/lib/place';
import { placeToRouteParams } from '@/lib/place';
import { INPUT_ALIGN_START } from '@/i18n/direction';

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
  const theme = useTheme();
  const outline = useControlOutline();
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

  return (
    <ThemedView type="background" style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={Spacing.two} style={styles.back}>
            <IconBack
              size={26}
              color={theme.text}
            />
          </Pressable>
          <ThemedView style={styles.fieldWrap}>
            <FieldShell>
              <IconSearch size={18} color={theme.text} />
              <TextInput
                autoFocus
                style={[styles.input, { color: theme.text }, Platform.OS === 'web' && styles.inputWebNoOutline]}
                placeholder={t(
                  field === 'origin'
                    ? 'search.originPlaceholder'
                    : field?.startsWith('saved-')
                      ? 'search.savedLocationPlaceholder'
                      : 'search.destinationPlaceholder',
                )}
                placeholderTextColor={theme.textSecondary}
                value={query}
                onChangeText={(text) => {
                  setQuery(text);
                  // A failed pick's message is about the list it was picked from.
                  setResolveFailed(false);
                }}
              />
            </FieldShell>
          </ThemedView>
          <MapPickButton
            onPress={() => {
              Keyboard.dismiss();
              router.push({ pathname: '/map-picker', params: { from: 'picker' } });
            }}
          />
        </ThemedView>

        {/* "Current location" leads the same row as the saved shortcuts
            rather than sitting under it as a row of its own: the three are
            one kind of thing -- a place the rider can pick without typing
            -- and splitting them put a full-width row between the chips and
            the list for what is the shortest answer of the lot. First,
            because it needs no setting up and is the likeliest of them. */}
        {(showCurrentLocation || savedShortcuts.length > 0) && (
          <ThemedView style={styles.chips}>
            <SavedLocationChips
              locations={savedShortcuts}
              // Non-null by construction: `savedShortcuts` is filtered on it.
              onSelect={(location) => location.place && commitPlace(location.place)}
              leading={showCurrentLocation ? (
                <Chip
                  icon={IconCurrentLocation}
                  label={t('search.currentLocation')}
                  busy={resolvingCurrentLocation}
                  onPress={() => void selectCurrentLocation()}
                />
              ) : null}
            />
          </ThemedView>
        )}

        {originFailed ? (
          <ThemedView style={styles.centered}>
            <ThemedText type="default" style={styles.originErrorText}>
              {t(
                search.originState.status === 'error' &&
                  search.originState.message === 'location_permission_denied'
                  ? 'search.locationPermissionDenied'
                  : 'search.locationUnavailable',
              )}
            </ThemedText>
            <Pressable onPress={search.retryOrigin} style={styles.retry}>
              <ThemedText type="smallBold">{t('search.retryLocation')}</ThemedText>
            </Pressable>
            <Pressable
              onPress={() =>
                router.push({ pathname: '/location-picker', params: { field: 'origin', andPlan: '1' } })
              }
              style={styles.retry}
            >
              <ThemedText type="smallBold">{t('search.chooseOrigin')}</ThemedText>
            </Pressable>
          </ThemedView>
        ) : waitingForOrigin ? (
          <ThemedView style={styles.centered}>
            <ActivityIndicator />
            {search.originState.status === 'error' && (
              <Pressable onPress={search.retryOrigin} style={styles.retry}>
                <ThemedText type="small" themeColor="textSecondary">
                  {t(search.originState.message === 'location_permission_denied' ? 'search.locationPermissionDenied' : 'search.locationUnavailable')}
                </ThemedText>
              </Pressable>
            )}
          </ThemedView>
        ) : (
          <>
            {resolveFailed && (
              <ThemedText type="small" themeColor="textSecondary" style={styles.noMatches}>
                {t('search.placeUnavailable')}
              </ThemedText>
            )}
            {showResults && rows.length > 0 && (
              <FlatList
                data={rows}
                keyExtractor={(item) => item.key}
                style={styles.list}
                keyboardShouldPersistTaps="handled"
                ItemSeparatorComponent={() => (
                  <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />
                )}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.row}
                    onPress={() => void selectRow(item)}
                    disabled={resolvingKey !== null}
                  >
                    {/* A stop's sign is a square of its own, so it goes without
                        the circle; its slot stays, keeping every row's text
                        on one edge. */}
                    <View
                      style={[
                        styles.iconCircle,
                        item.kind === 'address' || item.key === resolvingKey
                          ? [{ backgroundColor: theme.background }, outline]
                          : null,
                      ]}
                    >
                      {item.key === resolvingKey ? (
                        <ActivityIndicator size="small" />
                      ) : item.kind === 'stop' ? (
                        <StationIcon kind={stationKindOf(item)} />
                      ) : (
                        <IconMapPin size={18} color={theme.text} />
                      )}
                    </View>
                    <View style={styles.rowText}>
                      <ThemedText type="default">{item.title}</ThemedText>
                      {item.kind === 'address' && item.subtitle !== null && (
                        <ThemedText type="small" themeColor="textSecondary">
                          {item.subtitle}
                        </ThemedText>
                      )}
                      {item.kind === 'stop' && item.routes.length > 0 && (
                        <View style={styles.lineRow}>
                          {item.routes.slice(0, MAX_LINE_BADGES).map((route) => (
                            <LineBadge key={route.shortName} route={route} size="small" />
                          ))}
                          {item.routes.length > MAX_LINE_BADGES && (
                            <ThemedText type="small" themeColor="textSecondary">
                              {t('search.moreLines', { count: item.routes.length - MAX_LINE_BADGES })}
                            </ThemedText>
                          )}
                        </View>
                      )}
                    </View>
                  </Pressable>
                )}
              />
            )}
            {showResults && !isFetching && rows.length === 0 && (
              <ThemedText type="small" themeColor="textSecondary" style={styles.noMatches}>
                {t('search.noMatches')}
              </ThemedText>
            )}
            {/* What fills this screen before the rider types. Gated on
                `showResults` rather than on `query`, so it does not blink
                out during the debounce pause and back in again when a
                one-character query turns out not to search anything. */}
            {!showResults && (
              <View style={styles.recents}>
                {/* Straight into `commitPlace`, exactly where a tapped
                    search result ends up -- which is what lets these rows
                    stand in every mode this screen has. As a destination,
                    as an origin, or as the address being pinned to a saved
                    location, somewhere the rider looked up before is a
                    reasonable answer, and each mode already knows what to
                    do with a place. */}
                <RecentSearches onSelect={commitPlace} />
              </View>
            )}
          </>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    gap: Spacing.two,
  },
  back: {
    padding: Spacing.one,
  },
  fieldWrap: {
    flex: 1,
  },
  // The home screen's prompt is `smallBold`, and this is that same line in
  // that same shell one screen later -- so the placeholder has to land on
  // the identical metrics, or the field reads as changing size when tapped.
  //
  // `smallBold`'s `lineHeight` is deliberately NOT copied across: a `Text`
  // centers its glyphs inside that line box, but a `TextInput` offsets them
  // within it, so the same 20 that centers the home prompt pushes this one
  // off-center against the search glyph beside it. The rest of the row's
  // vertical centering is the shell's `alignItems`, which only works if the
  // input contributes no padding of its own -- hence the zeroes below, and
  // `includeFontPadding`, which is Android's own invisible extra.
  input: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    textAlign: INPUT_ALIGN_START,
    // `smallBold`'s line box as a HEIGHT rather than as `lineHeight`: a
    // single-line input centers its glyphs inside its frame, so this keeps
    // the field exactly as tall as the home screen's prompt while leaving
    // the text on the icon's centerline. As `lineHeight` it did the
    // opposite -- right height, text riding above center.
    height: 20,
    padding: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  inputWebNoOutline: {
    outlineWidth: 0,
  },
  chips: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
  },
  list: {
    marginTop: Spacing.four,
  },
  // Carries the page inset for the rows inside it -- `RecentSearches` lays out
  // a bare column, the way the list above it does.
  recents: {
    marginTop: Spacing.four,
    paddingHorizontal: Spacing.four,
  },
  // Deliberately shorter than the home screen's rows: this list runs to
  // hundreds of entries and is scanned, not read.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.four,
  },
  rowText: {
    flex: 1,
    gap: Spacing.one,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  noMatches: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  originErrorText: {
    textAlign: 'center',
  },
  retry: {
    paddingHorizontal: Spacing.four,
  },
});
