import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useStopBrowse } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import {
  EmptyState,
  GroupedItemSeparator,
  Layout,
  ListRow,
  ListSection,
  Loading,
  PageTitle,
  SearchField,
  Space,
  Surface,
  Text,
  useGroupedItemStyle,
} from '@/design-system';
import { JourneyDock, useJourneyDockInset } from '@/features/journey/journey-bar';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { NearbyStops } from '@/features/nearby/nearby-stops';
import { useRecents } from '@/features/recents/recents-context';

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

/** Nearby is the whole browse list on this tab -- anything further away is a
 *  search -- so it lists more than the home screen's handful. */
const NEARBY_STOPS = 10;

/** One stop, in the list and in the recents strip above it. Recents carry a
 *  name and nothing else, so `routes` is optional rather than a second row
 *  component that would drift from this one. `dense` in the catalogue: it
 *  runs to thousands of entries and is scanned, not read. */
function StationRow({ name, routes, rail = false, stationKind, onPress, dense = false, style }: {
  name: string;
  routes?: StopRouteBrief[];
  rail?: boolean;
  stationKind?: string;
  onPress: () => void;
  dense?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const badges = routes ?? [];

  return (
    <ListRow
      leading={<StationIcon kind={stationKindOf({ rail, stationKind })} />}
      title={name}
      subtitle={
        badges.length > 0 ? (
          <View style={styles.lineRow}>
            {badges.slice(0, MAX_LINE_BADGES).map((route) => (
              <LineBadge key={route.shortName} route={route} size="small" />
            ))}
            {badges.length > MAX_LINE_BADGES && (
              <Text variant="footnote" color="textSecondary" numeric>
                {t('search.moreLines', { count: badges.length - MAX_LINE_BADGES })}
              </Text>
            )}
          </View>
        ) : undefined
      }
      dense={dense}
      onPress={onPress}
      style={style}
    />
  );
}

/**
 * Every stop in the feed, by search; the ones that matter, without one.
 *
 * The counterpart to the Lines tab: a rider who knows where they want to
 * stand rather than which line they want to catch. With the field empty the
 * tab offers the stops they have opened before and the ones they are standing
 * next to -- the two that answer the question nearly every time. Anything
 * else is a search.
 *
 * One `FlatList` rather than a `ScrollView` holding a list: a search can run
 * many pages deep and has to stay virtualised. So recents and nearby ride
 * along as the list's header and the whole screen scrolls as one column.
 */
export default function StationsScreen() {
  const { t, i18n } = useTranslation();
  const dockInset = useJourneyDockInset();
  // The end of the content scrolls clear of the tab bar (see the hook).
  const tabBarInset = useTabBarInset();
  const { stations: recents, recordStation } = useRecents();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = debouncedQuery.trim() !== '';
  // Only while searching: browsing is recents and nearby, not an A-to-Z of
  // tens of thousands of stops nobody scrolled through.
  const { data, fetchNextPage, hasNextPage, isFetching } = useStopBrowse(debouncedQuery, i18n.language, {
    enabled: searching,
  });
  const stops = searching ? (data?.pages.flatMap((page) => page.stops) ?? []) : [];
  const groupedItem = useGroupedItemStyle();

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
        <ListSection title={t('stations.recent')} style={styles.groupedSection}>
          {recents.map((station) => (
            <StationRow
              key={station.stopId}
              name={station.name}
              rail={station.rail}
              stationKind={station.stationKind}
              onPress={() => openStation(station.stopId, station.name, station.rail === true, station.stationKind)}
            />
          ))}
        </ListSection>
      )}

      {/* Inset here rather than inside it: the section is shared with the
          home screen, which insets its whole column instead. */}
      <View style={styles.groupedSection}>
        <NearbyStops limit={NEARBY_STOPS} footer={t('stations.searchHint')} />
      </View>
    </View>
  );

  return (
    <Surface level="bgGrouped" style={styles.container}>
      {/* Top edge only, like the other tabs: the tab bar already clears the
          home indicator, and taking the bottom inset here too would leave a
          dead band above it. Tab roots have no native header, so the title is
          drawn in content. */}
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <PageTitle>{t('stations.title')}</PageTitle>

        <SearchField
          style={styles.field}
          placeholder={t('stations.search')}
          value={query}
          onChangeText={setQuery}
          // Clearing is an answer, not typing: drop the debounce so the
          // browse list comes straight back.
          onClear={() => {
            setQuery('');
            setDebouncedQuery('');
          }}
          clearLabel={t('common.clear')}
        />

        {/* The screen's first scrollable view, so the native tab bar on iOS
            finds it and applies its automatic content insets. */}
        <FlatList
          data={stops}
          keyExtractor={(item) => item.stopId}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          // The journey bar docks above the tab bar, so the list has to end
          // clear of both or its last row is unreachable mid-journey.
          contentContainerStyle={{ paddingBottom: Layout.sectionGap + dockInset + tabBarInset }}
          ItemSeparatorComponent={GroupedItemSeparator}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasNextPage && !isFetching) fetchNextPage();
          }}
          ListEmptyComponent={
            !searching ? null : isFetching ? (
              <Loading />
            ) : (
              <EmptyState icon="search" title={t('stations.empty')} />
            )
          }
          // One grouped section, drawn a slice per item so the list stays
          // virtualised -- see `useGroupedItemStyle`.
          renderItem={({ item, index }) => (
            <StationRow
              name={item.name ?? item.stopId}
              routes={item.routes}
              rail={item.rail}
              stationKind={item.stationKind}
              onPress={() => openStation(item.stopId, item.name ?? item.stopId, item.rail === true, item.stationKind)}
              dense
              style={groupedItem(index, stops.length)}
            />
          )}
        />
      </SafeAreaView>

      <JourneyDock />
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  field: {
    marginHorizontal: Layout.pageInset,
    marginBottom: Space.lg,
  },
  // This column is what holds the page's sections apart, so the gap lives
  // here and each section carries none of its own -- the two stacked would
  // double it.
  header: {
    gap: Layout.sectionGap,
    paddingTop: Space.sm,
  },
  // Grouped sections sit inset from the screen edge.
  groupedSection: {
    marginHorizontal: Layout.pageInset,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
