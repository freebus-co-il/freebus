import { IconMapPin, IconSearch } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ADDRESS_MIN_QUERY_LENGTH, newGeocodeSession, resolvePlace, useAddressSearch } from '@/api/geocode';
import { useStopSearch } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { IconBack } from '@/components/directional-icon';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { FieldShell } from '@/features/search/field-shell';
import { leaveDestination } from '@/features/stations/destination-handoff';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { INPUT_ALIGN_START } from '@/i18n/direction';

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
  const theme = useTheme();
  const outline = useControlOutline();
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
    <ThemedView type="background" style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={Spacing.two} style={styles.back}>
            <IconBack size={26} color={theme.text} />
          </Pressable>
          <ThemedView style={styles.fieldWrap}>
            <FieldShell>
              <IconSearch size={18} color={theme.text} />
              <TextInput
                autoFocus
                style={[styles.input, { color: theme.text }, Platform.OS === 'web' && styles.inputWebNoOutline]}
                placeholder={t('station.destinationPlaceholder')}
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
        </ThemedView>

        {resolveFailed && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.notice}>
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
                accessibilityRole="button"
                disabled={resolvingKey !== null}
                onPress={() => void selectRow(item)}
              >
                {/* A stop's sign is a square of its own, so it goes without
                    the circle; its slot stays, keeping every row's text on
                    one edge. */}
                <View
                  style={[
                    styles.iconSlot,
                    item.kind === 'place' || item.key === resolvingKey
                      ? [styles.iconCircle, { backgroundColor: theme.background }, outline]
                      : null,
                  ]}
                >
                  {item.key === resolvingKey ? (
                    <ActivityIndicator size="small" />
                  ) : item.kind === 'stop' ? (
                    <StationIcon kind={stationKindOf({ stationKind: item.stationKind, rail: item.rail })} />
                  ) : (
                    <IconMapPin size={18} color={theme.text} />
                  )}
                </View>
                <View style={styles.rowText}>
                  <ThemedText type="default">{item.title}</ThemedText>
                  {item.kind === 'place' && item.subtitle !== null && (
                    <ThemedText type="small" themeColor="textSecondary">{item.subtitle}</ThemedText>
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
        {showResults && isFetching && rows.length === 0 && (
          <View style={styles.status}><ActivityIndicator /></View>
        )}
        {showResults && !isFetching && rows.length === 0 && !placesPending && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.notice}>
            {t('search.noMatches')}
          </ThemedText>
        )}
        {!showResults && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.notice}>
            {t('station.destinationHint')}
          </ThemedText>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    gap: Spacing.two,
  },
  back: { padding: Spacing.one },
  fieldWrap: { flex: 1 },
  // The location picker's field metrics, comment and all -- the two screens
  // show the same shell and must not differ by a pixel.
  input: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    textAlign: INPUT_ALIGN_START,
    height: 20,
    padding: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  inputWebNoOutline: { outlineWidth: 0 },
  list: { marginTop: Spacing.four },
  // A catalogue, scanned rather than read: `Spacing.three` rows, as the
  // other long lists in the app use.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  iconSlot: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircle: { borderRadius: 18 },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.four,
  },
  rowText: { flex: 1, gap: Spacing.one },
  lineRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.one,
  },
  status: { paddingTop: Spacing.four, alignItems: 'center' },
  notice: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
  },
});
