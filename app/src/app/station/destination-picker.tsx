import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ADDRESS_MIN_QUERY_LENGTH, newGeocodeSession, resolvePlace, useAddressSearch } from '@/api/geocode';
import { useStopSearch } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { DataCredit } from '@/components/data-credit';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import {
  Banner,
  EmptyState,
  Icon,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  Loading,
  SearchHeader,
  Space,
  Surface,
  Text,
} from '@/design-system';
import { leaveDestination } from '@/features/stations/destination-handoff';
import { addressCredit } from '@/lib/attribution';

/** The same pause the location picker gives stop search, and for the same
 *  reason: `/stops/search` is local and free, so it can afford to be brisk. */
const SEARCH_DEBOUNCE_MS = 275;

/** And the same longer pause for places, for the same reason: the geocoder
 *  may be Google-backed and billed per request. See the location picker. */
const ADDRESS_DEBOUNCE_MS = 450;

/** See the location picker's own constant -- eight stops sharing a street
 *  name are told apart by the lines calling at each. */
const MAX_LINE_BADGES = 6;

type Row =
  | {
    kind: 'stop'; key: string; title: string; lat: number; lon: number;
    routes: StopRouteBrief[]; rail: boolean; stationKind: string | undefined;
  }
  | {
    kind: 'place'; key: string; title: string; subtitle: string | null;
    /** Null exactly when the geocoder hands back an id to resolve on tap --
     *  see `resolvePlace`. */
    lat: number | null; lon: number | null; placeId: string | null;
  };

/**
 * Picking the place a board is filtered to.
 *
 * Stops AND places, because the thing a rider can name is almost never the
 * thing the feed calls a stop. "The railway station" is a place; the bus
 * stop outside it is "דרך מנחם בגין/נחמני", which nobody searches for. So
 * whatever is picked here becomes a POINT, and the server keeps the runs
 * that stop near it.
 */
export default function DestinationPickerScreen() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [debouncedAddress, setDebouncedAddress] = useState('');
  // One geocoder billing session per pick -- see `newGeocodeSession`.
  const [geocodeSession, setGeocodeSession] = useState(newGeocodeSession);
  /** The place row whose position is being fetched after a tap. */
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [resolveFailed, setResolveFailed] = useState(false);

  useEffect(() => {
    const stops = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    const addresses = setTimeout(() => setDebouncedAddress(query), ADDRESS_DEBOUNCE_MS);
    return () => {
      clearTimeout(stops);
      clearTimeout(addresses);
    };
  }, [query]);

  const { data: stopData, isFetching: stopsFetching } = useStopSearch(debounced, i18n.language);
  const { data: placeData, isFetching: placesFetching } = useAddressSearch(
    debouncedAddress, i18n.language, { session: geocodeSession, near: null },
  );

  // Stops first, then places, each in its backend's own relevance order --
  // the same fallback ordering the location picker uses when it has no GPS
  // fix to rank by. A stop is the more precise answer when the rider's words
  // actually matched one.
  const rows: Row[] = [
    ...(stopData?.stops ?? []).map((s): Row => ({
      kind: 'stop', key: `stop:${s.stopId}`, title: s.name ?? s.stopId,
      lat: s.lat, lon: s.lon, routes: s.routes, rail: s.rail === true, stationKind: s.stationKind,
    })),
    ...(placeData?.places ?? []).map((p, i): Row => ({
      kind: 'place', key: `place:${i}:${p.placeId ?? `${p.lat},${p.lon}`}`,
      title: p.label, subtitle: p.secondaryLabel,
      lat: p.lat, lon: p.lon, placeId: p.placeId,
    })),
  ];
  const credit = addressCredit(placeData?.attribution, rows.filter((r) => r.kind === 'place').length);

  // Gated on the debounced query as well, so nothing flashes "no matches"
  // during the pause before the requests go out.
  const showResults = debounced.trim().length >= 2 && query.trim().length >= 2;
  const isFetching = stopsFetching || placesFetching;
  // Places need a longer query than stops do, so while the rider is still
  // short of it the list is honestly incomplete rather than empty.
  const placesPending = query.trim().length < ADDRESS_MIN_QUERY_LENGTH;

  async function selectRow(row: Row) {
    if (row.kind === 'stop') {
      leaveDestination({ name: row.title, lat: row.lat, lon: row.lon });
      router.back();
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

    // Left for the board to take on focus, not pushed at it -- see
    // `destination-handoff`.
    leaveDestination({ name: row.title, lat: position.lat, lon: position.lon });
    router.back();
  }

  return (
    <Surface level="bgGrouped" style={styles.container}>
      {/* No title: the field's prompt says what is being picked. */}
      {/* The back button beside the field, one row of glass -- the same
          search bar as the location picker. */}
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        <View style={styles.top}>
          <SearchHeader
            onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            backLabel={t('common.back')}
            autoFocus
            placeholder={t('station.destinationPlaceholder')}
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
          />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          // The field is autofocused, so the keyboard is up: the default would
          // spend the first tap on dismissing it and never fire the row.
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
                    // Ignored rather than `disabled` while one place is being
                    // positioned: disabling would dim the whole list.
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
                        <StationIcon kind={stationKindOf({ stationKind: item.stationKind, rail: item.rail })} />
                      ) : (
                        <LeadingIcon>
                          <Icon name="place" size="sm" weight="medium" />
                        </LeadingIcon>
                      )
                    }
                    title={item.title}
                    subtitle={
                      item.kind === 'place'
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
          {showResults && isFetching && rows.length === 0 && <Loading />}
          {showResults && !isFetching && rows.length === 0 && !placesPending && (
            <EmptyState icon="search" title={t('search.noMatches')} />
          )}
          {!showResults && (
            <Text variant="subheadline" color="textSecondary" style={styles.hint}>
              {t('station.destinationHint')}
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  top: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.sm,
  },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.xxl,
    paddingBottom: Layout.sectionGap,
    gap: Layout.sectionGap,
  },
  results: { gap: Space.md },
  // `Loading` centres itself in padding meant for a page; in a row's tile it
  // has only the tile to fill.
  rowSpinner: { paddingVertical: Space.none },
  lineRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Space.xs,
  },
  // Inset like a section's header text, so it lines up with the rows that
  // replace it once the rider types.
  hint: { paddingHorizontal: Layout.rowPaddingH },
});
