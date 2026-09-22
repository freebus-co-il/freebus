import { IconSearch } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useStopBrowse } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SectionGap, Spacing } from '@/constants/theme';
import { NearbyStops } from '@/features/nearby/nearby-stops';
import { useRecents } from '@/features/recents/recents-context';
import { FieldShell } from '@/features/search/field-shell';
import { useTheme } from '@/hooks/use-theme';
import { INPUT_ALIGN_START } from '@/i18n/direction';

/** The same pause the location picker waits before it queries `/stops/search`
 *  -- long enough that typing a stop name is one request rather than one per
 *  keystroke, short enough to still feel like filtering. Kept identical on
 *  purpose: the two screens search the same endpoint, and a rider who learns
 *  the feel of one is using the other. */
const SEARCH_DEBOUNCE_MS = 275;

/** Badges per stop before the rest collapse into a "+N" -- the location
 *  picker's own cap, and for its reason: a street name returns eight stops
 *  with the same name and the lines calling at each are the only thing that
 *  tells them apart. Six fits one unwrapped row at the narrowest width. */
const MAX_LINE_BADGES = 6;

/** One stop, in the list and in the recents strip above it. Recents carry a
 *  name and nothing else, so `routes` is optional rather than a second row
 *  component that would drift from this one. */
function StationRow({ name, routes, rail = false, stationKind, onPress }: {
  name: string;
  routes?: StopRouteBrief[];
  rail?: boolean;
  stationKind?: string;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const badges = routes ?? [];

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <StationIcon kind={stationKindOf({ rail, stationKind })} />
      <View style={styles.rowText}>
        <ThemedText type="default">{name}</ThemedText>
        {badges.length > 0 && (
          <View style={styles.lineRow}>
            {badges.slice(0, MAX_LINE_BADGES).map((route) => (
              <LineBadge key={route.shortName} route={route} size="small" />
            ))}
            {badges.length > MAX_LINE_BADGES && (
              <ThemedText type="small" themeColor="textSecondary">
                {t('search.moreLines', { count: badges.length - MAX_LINE_BADGES })}
              </ThemedText>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Every stop in the feed, searchable and browsable.
 *
 * The counterpart to the Lines tab: a rider who knows where they want to
 * stand rather than which line they want to catch. Typing filters the whole
 * feed; typing nothing browses it alphabetically, with the stops they have
 * opened before and the ones they are standing next to offered first, since
 * those two answer the question far more often than the A-to-Z does.
 *
 * One `FlatList` rather than a `ScrollView` holding a list: the alphabetical
 * browse is tens of thousands of stops deep and has to be virtualised, and
 * nesting it inside a scroll view would both trap the gesture and defeat that
 * windowing. So recents and nearby ride along as the list's header and the
 * whole screen scrolls as one column.
 */
export default function StationsScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { stations: recents, recordStation } = useRecents();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, fetchNextPage, hasNextPage, isFetching } = useStopBrowse(debouncedQuery, i18n.language);
  const stops = data?.pages.flatMap((page) => page.stops) ?? [];
  const searching = debouncedQuery.trim() !== '';

  /** The visit is recorded BEFORE the push, so the row that sent us there is
   *  already at the top of the recents strip when the rider comes back. */
  function openStation(stopId: string, name: string, rail: boolean, stationKind: string | undefined) {
    recordStation({ kind: 'station', stopId, name, rail, stationKind });
    router.push({ pathname: '/station/[stopId]', params: { stopId, name } });
  }

  // Only while browsing: a search is a list of answers, and prefixing it with
  // recents and nearby would bury the ones the rider actually asked for.
  const header = searching ? null : (
    <View style={styles.header}>
      {recents.length > 0 && (
        <View style={styles.section}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            {t('stations.recent')}
          </ThemedText>
          <View>
            {recents.map((station, index) => (
              <Fragment key={station.stopId}>
                {index > 0 && <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />}
                <StationRow
                  name={station.name}
                  rail={station.rail}
                  stationKind={station.stationKind}
                  onPress={() => openStation(station.stopId, station.name, station.rail === true, station.stationKind)}
                />
              </Fragment>
            ))}
          </View>
        </View>
      )}

      {/* Renders nothing at all without a GPS fix, so the "All stations"
          heading below simply moves up. Padded here rather than inside it:
          the section is shared with the home screen, which pads its whole
          column instead. */}
      <View style={styles.nearby}>
        <NearbyStops />
      </View>

      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.allHeading}>
        {t('stations.all')}
      </ThemedText>
    </View>
  );

  return (
    <ThemedView type="background" style={styles.container}>
      {/* Top edge only, like the other tabs: the tab bar already clears the
          home indicator, and taking the bottom inset here too would leave a
          dead band above it. */}
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ThemedText type="title" style={styles.heading}>
          {t('stations.title')}
        </ThemedText>

        <View style={styles.field}>
          <FieldShell>
            <IconSearch size={18} color={theme.text} />
            <TextInput
              style={[styles.input, { color: theme.text }, Platform.OS === 'web' && styles.inputWebNoOutline]}
              placeholder={t('stations.search')}
              placeholderTextColor={theme.textSecondary}
              value={query}
              onChangeText={setQuery}
            />
          </FieldShell>
        </View>

        <FlatList
          data={stops}
          keyExtractor={(item) => item.stopId}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          // The journey bar docks above the tab bar, so the list has to end
          // clear of both or its last row is unreachable mid-journey.
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />
          )}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasNextPage && !isFetching) fetchNextPage();
          }}
          ListEmptyComponent={
            isFetching ? (
              <ActivityIndicator style={styles.emptyLoader} />
            ) : searching ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
                {t('stations.empty')}
              </ThemedText>
            ) : null
          }
          renderItem={({ item }) => (
            <StationRow
              name={item.name ?? item.stopId}
              routes={item.routes}
              rail={item.rail}
              stationKind={item.stationKind}
              onPress={() => openStation(item.stopId, item.name ?? item.stopId, item.rail === true, item.stationKind)}
            />
          )}
        />
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
  heading: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
  },
  field: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
  },
  // Matches the location picker's field exactly -- see its own comment for
  // why the line box is a `height` and not a `lineHeight`, and why the input
  // contributes no padding of its own.
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
  inputWebNoOutline: {
    outlineWidth: 0,
  },
  // No horizontal padding of its own: the rows inside carry theirs, so
  // padding here would inset them twice.
  // This column is what holds the page's sections apart, so the gap lives
  // here and each section carries none of its own -- the two stacked would
  // double it.
  header: {
    gap: SectionGap,
  },
  // No gap under a list heading: the first row's own vertical padding is
  // the space. A gap on top of that padding reads as a bigger break than
  // the one between the rows themselves, which says the heading is not
  // attached to the list it names.
  section: {
    gap: 0,
  },
  sectionTitle: {
    paddingHorizontal: Spacing.four,
  },
  nearby: {
    paddingHorizontal: Spacing.four,
  },
  allHeading: {
    paddingHorizontal: Spacing.four,
  },
  listContent: {
    paddingBottom: Spacing.five,
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
  rowText: {
    flex: 1,
    gap: Spacing.one,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.four,
  },
  empty: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
  },
  emptyLoader: {
    paddingTop: Spacing.four,
  },
});
