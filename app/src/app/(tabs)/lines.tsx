import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useAgencies } from '@/api/agencies';
import { apiGet } from '@/api/client';
import { ROUTES_PAGE_SIZE, useRouteSearch } from '@/api/lines';
import { useTransitModes } from '@/api/modes';
import { useNearbyStops } from '@/api/stops';
import type { RoutesResponse, StopRouteBrief } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import {
  EmptyState,
  GroupedItemSeparator,
  Layout,
  ListRow,
  ListSection,
  Loading,
  PageTitle,
  ScrollHeader,
  SearchField,
  Space,
  Surface,
  Text,
  useGroupedItemStyle,
  useScrollHeader,
} from '@/design-system';
import { JourneyDock, useJourneyDockInset } from '@/features/journey/journey-bar';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import {
  agenciesForTypes,
  effectiveTypes,
  excludeType,
  lockedType,
  typesForAgencies,
  type AgencyTypes,
} from '@/features/lines/filter-interlock';
import { groupRoutes, type Line } from '@/features/lines/group-routes';
import { LineFilterChip } from '@/features/lines/line-filter-chip';
import { useRecents } from '@/features/recents/recents-context';
import { useSearch } from '@/features/search/search-context';
import { formatDistanceMeters } from '@/lib/format';

/** The location picker's pause, kept identical -- see `stations.tsx`. */
const SEARCH_DEBOUNCE_MS = 275;

/** How many of the closest stops the nearby lines are drawn from, and how many
 *  lines the section lists. Nearby is the whole browse list now -- anything
 *  further away is a search. */
const NEARBY_STOPS = 10;
const MAX_NEARBY_LINES = 10;

/**
 * Rail, which this tab does not show.
 *
 * Every rail route in the feed carries an empty `route_short_name` and no
 * line code, so each one lands as an unnamed, ungroupable "line" that crowds
 * out the numbered ones this list exists to browse. Trains are still
 * everywhere else in the app -- station boards, departures, trip plans; it is
 * only the browse-by-number list they do not belong in.
 */
const RAIL_TYPE = 2;

/**
 * A line's identity, without the route rows only the browse list carries.
 *
 * Both a grouped `Line` and a stored `RecentLine` satisfy it, which is what
 * lets the recents strip and the list draw the same row rather than two that
 * drift apart.
 */
type LineSummary = Omit<Line, 'routeIds'>;

/** A nearby line, with the closest stop it calls at. */
type NearbyLine = { route: StopRouteBrief; stopName: string | null; distanceMeters: number };

function nearbyKey(route: StopRouteBrief): string {
  return `${route.shortName}:${route.agencyId ?? ''}`;
}

/** One line, as the badge a rider recognises plus where it goes. `dense` in a
 *  search result: it is scanned, not read. */
function LineRow({ line, onPress, dense = false, style }: {
  line: LineSummary;
  onPress: () => void;
  dense?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <ListRow
      // No `color`: `LineBadge` fills from the OPERATOR, not from the feed's
      // per-route colour, so its route shape has no colour field to pass.
      leading={<LineBadge route={{ shortName: line.shortName, agencyId: line.agencyId, type: line.type }} />}
      title={line.longName ?? ''}
      titleLines={1}
      dense={dense}
      onPress={onPress}
      style={style}
    />
  );
}

/**
 * Every line in the feed, by search and filter; the ones running past the
 * rider, without one. With the field empty the tab offers recent lines and
 * the lines at the closest stops; anything else is a search.
 *
 * The list's one piece of real work is that a "line" is not a route row: the
 * feed stores one row per direction per alternative, so line 34001 arrives as
 * four rows and a raw list would show it four times. `groupRoutes` collapses
 * them -- over the whole accumulated result, never page by page; see the
 * `lines` memo for why that distinction is the difference between a correct
 * list and one that quietly duplicates lines at every page boundary.
 */
export default function LinesScreen() {
  const { t, i18n } = useTranslation();
  const dockInset = useJourneyDockInset();
  // The end of the content scrolls clear of the tab bar (see the hook).
  const tabBarInset = useTabBarInset();
  const scrollHeader = useScrollHeader();
  const { lines: recents, recordLine } = useRecents();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // The rider's OWN two selections. Everything the filters show is derived
  // from this pair and the feed -- see `filter-interlock`, and note that the
  // type the interlock infers is never written back here: it is not a choice
  // the rider made, and storing it would strand them in it.
  const [selectedAgencies, setSelectedAgencies] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<number[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: agencyData } = useAgencies();
  const { data: modeData } = useTransitModes();
  const agencies = useMemo(() => agencyData?.agencies ?? [], [agencyData]);
  const modes = useMemo(() => modeData?.modes ?? [], [modeData]);

  // The feed the two filters interlock over: every operator with the vehicle
  // types it runs, rail stripped out along with any operator that runs
  // nothing else.
  //
  // `types` is a field the API can omit for an operator; one that arrives
  // without it is read as running everything: the drawers stay full and
  // nothing locks, which is a filter that merely fails to narrow rather than
  // one that offers nothing at all.
  const feed = useMemo<AgencyTypes[]>(() => {
    const everything = modes.map((mode) => mode.type);
    return excludeType(
      agencies.map((agency) => ({
        agencyId: agency.agencyId,
        types: agency.types?.length ? agency.types : everything,
      })),
      RAIL_TYPE,
    );
  }, [agencies, modes]);

  // Each drawer lists only what the other one's selection leaves standing, so
  // a combination with no lines in it cannot be built in the first place.
  const availableTypes = useMemo(
    () => typesForAgencies(feed, selectedAgencies),
    [feed, selectedAgencies],
  );
  const availableAgencies = useMemo(
    () => agenciesForTypes(feed, selectedTypes),
    [feed, selectedTypes],
  );
  const locked = lockedType(feed, selectedAgencies);
  const types = useMemo(
    () => effectiveTypes(feed, selectedAgencies, selectedTypes),
    [feed, selectedAgencies, selectedTypes],
  );

  const searching = debouncedQuery.trim() !== '';
  // Only while searching: browsing is recents and nearby, and paging the whole
  // feed for a list nobody scrolled was the one thing left on this tab that
  // was not about where the rider is.
  const { data, fetchNextPage, hasNextPage, isFetching } = useRouteSearch(
    debouncedQuery,
    { agencies: selectedAgencies, types, excludeTypes: [RAIL_TYPE] },
    { enabled: searching },
  );

  // Grouped over EVERY page loaded so far, never page by page: a line's two
  // directions can straddle a page boundary, and grouping each page alone
  // would emit that line twice and never merge them. See `groupRoutes`.
  const lines = useMemo(
    () => groupRoutes(data?.pages.flatMap((page) => page.routes) ?? []),
    [data],
  );

  // The app's own label wins; the backend's English GTFS name is the fallback
  // for a type shipped by a feed newer than this build. Same lookup as the
  // results screen's mode filter -- i18next's `defaultValue` IS the fallback,
  // there is no second lookup path.
  const modeLabel = (type: number) => {
    const name = modes.find((mode) => mode.type === type)?.name;
    return t(`results.modeType.${type}`, { defaultValue: name ?? String(type) });
  };

  const agencyOptions = availableAgencies.map((agency) => ({
    value: agency.agencyId,
    label: agencies.find((row) => row.agencyId === agency.agencyId)?.name ?? agency.agencyId,
  }));
  const typeOptions = availableTypes.map((type) => ({ value: type, label: modeLabel(type) }));

  // Same raw GPS fix the home screen's nearby section reads, and for the same
  // reason: this is "what runs past me right now", not the origin of whatever
  // trip is being planned.
  const { originState } = useSearch();
  const here = originState.status === 'success' && originState.place.kind === 'coordinate'
    ? originState.place
    : null;
  const { data: nearbyData } = useNearbyStops(here && { lat: here.lat, lon: here.lon }, i18n.language, NEARBY_STOPS);

  // Deduped on number-plus-operator, which is all these briefs carry. The
  // stops arrive nearest first, so the first stop a line turns up at is the
  // closest place to catch it -- the row names that stop and its distance.
  const nearbyLines = useMemo(() => {
    const seen = new Map<string, NearbyLine>();
    for (const stop of nearbyData?.stops ?? []) {
      // `?? []`: absent, not merely empty, on an API older than this tab.
      for (const route of stop.routes ?? []) {
        const key = nearbyKey(route);
        if (!seen.has(key)) seen.set(key, { route, stopName: stop.name, distanceMeters: stop.distanceMeters });
      }
    }
    return [...seen.values()].slice(0, MAX_NEARBY_LINES);
  }, [nearbyData]);
  const [resolving, setResolving] = useState<string | null>(null);

  const groupedItem = useGroupedItemStyle();

  /** Recorded BEFORE the push, so the line that was just opened is already at
   *  the top of the recents strip when the rider comes back. */
  function openLine(line: LineSummary) {
    recordLine({
      kind: 'line',
      lineCode: line.lineCode,
      shortName: line.shortName,
      longName: line.longName,
      agencyId: line.agencyId,
      type: line.type,
    });
    router.push({ pathname: '/line/[lineCode]', params: { lineCode: line.lineCode } });
  }

  /**
   * A nearby brief carries a number and an operator but no line code, so the
   * line is looked up first. One exact match opens its page; anything else --
   * no match, several lines sharing the number, a failed lookup -- becomes a
   * search for the number, where the rider can pick.
   */
  async function openNearbyLine({ route }: NearbyLine) {
    const key = nearbyKey(route);
    if (resolving !== null) return;
    setResolving(key);
    const searchFor = () => {
      setQuery(route.shortName);
      setDebouncedQuery(route.shortName);
    };
    try {
      const response = await apiGet<RoutesResponse>('/routes', {
        q: route.shortName,
        agency: route.agencyId ?? undefined,
        limit: ROUTES_PAGE_SIZE,
      });
      const matches = groupRoutes(response.routes).filter(
        (line) => line.shortName?.trim() === route.shortName.trim() && line.agencyId === route.agencyId,
      );
      if (matches.length === 1) openLine(matches[0]!);
      else searchFor();
    } catch {
      searchFor();
    } finally {
      setResolving(null);
    }
  }

  // Only while browsing: a search is a list of answers, and prefixing it with
  // recents and nearby would bury the ones the rider actually asked for.
  const header = searching ? null : (
    <View style={styles.header}>
      {recents.length > 0 && (
        <ListSection title={t('lines.recent')} style={styles.groupedSection}>
          {recents.map((line) => (
            <LineRow key={line.lineCode} line={line} onPress={() => openLine(line)} />
          ))}
        </ListSection>
      )}

      {nearbyLines.length > 0 && (
        <ListSection title={t('lines.nearby')} footer={t('lines.searchHint')} style={styles.groupedSection}>
          {nearbyLines.map((nearby) => {
            const key = nearbyKey(nearby.route);
            const operator = agencies.find((agency) => agency.agencyId === nearby.route.agencyId)?.name;
            return (
              <ListRow
                key={key}
                leading={<LineBadge route={nearby.route} />}
                title={operator ?? modeLabel(nearby.route.type)}
                titleLines={1}
                subtitle={nearby.stopName ?? undefined}
                trailing={
                  resolving === key ? (
                    <Loading style={styles.rowSpinner} />
                  ) : (
                    <Text variant="footnote" color="textSecondary" numeric>
                      {formatDistanceMeters(nearby.distanceMeters)}
                    </Text>
                  )
                }
                accessory="chevron"
                onPress={() => void openNearbyLine(nearby)}
              />
            );
          })}
        </ListSection>
      )}
    </View>
  );

  return (
    <Surface level="bgGrouped" style={styles.container}>
      {/* Tab roots have no native header, so the title and search are drawn
          in content -- as a fixed header the list scrolls under, which takes
          a glass backing once it does. It takes the top safe-area inset
          itself. */}
      <View style={styles.safeArea}>
        {/* The screen's first scrollable view, so the native tab bar on iOS
            finds it to minimise on scroll. Insets are applied by hand: the
            header's height on top, the tab bar's and the dock's below. */}
        <FlatList
          data={searching ? lines : []}
          keyExtractor={(item) => item.lineCode}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
          onScroll={scrollHeader.onScroll}
          scrollEventThrottle={scrollHeader.scrollEventThrottle}
          ListHeaderComponent={header}
          // The journey bar docks above the tab bar, so the list has to end
          // clear of both or its last row is unreachable mid-journey.
          contentContainerStyle={{ paddingTop: scrollHeader.height, paddingBottom: Layout.sectionGap + dockInset + tabBarInset }}
          ItemSeparatorComponent={GroupedItemSeparator}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasNextPage && !isFetching) fetchNextPage();
          }}
          ListEmptyComponent={
            !searching ? null : isFetching ? (
              <Loading />
            ) : (
              <EmptyState icon="search" title={t('lines.empty')} />
            )
          }
          // One grouped section, drawn a slice per item so the list stays
          // virtualised -- see `useGroupedItemStyle`.
          renderItem={({ item, index }) => (
            <LineRow line={item} onPress={() => openLine(item)} dense style={groupedItem(index, lines.length)} />
          )}
        />

        <ScrollHeader scrolled={scrollHeader.scrolled} progress={scrollHeader.progress} onLayout={scrollHeader.onLayout}>
          <PageTitle>{t('lines.title')}</PageTitle>

          <SearchField
            style={styles.field}
            placeholder={t('lines.search')}
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

          {/* Two chips, side by side, each opening its own drawer. No
              horizontal ScrollView: two pills fit any phone, and wrapping them
              in one is what squeezed their labels down to a single glyph. */}
          <View style={styles.filterRow}>
            <LineFilterChip
              icon="operator"
              title={t('lines.operatorFilterTitle')}
              options={agencyOptions}
              selected={selectedAgencies}
              onCommit={setSelectedAgencies}
              allLabel={t('lines.operatorFilterAll')}
              countLabel={t('lines.operatorFilterCount', { count: selectedAgencies.length })}
              resetLabel={t('lines.operatorFilterReset')}
            />
            {/* Locked once the chosen operators run a single kind of vehicle:
                there is no second answer left for this filter to give, so it
                names the one it is pinned to instead of opening on it. */}
            <LineFilterChip
              icon="bus"
              title={t('lines.vehicleFilterTitle')}
              options={typeOptions}
              selected={selectedTypes}
              onCommit={setSelectedTypes}
              allLabel={t('lines.vehicleFilterAll')}
              countLabel={t('lines.vehicleFilterCount', { count: selectedTypes.length })}
              resetLabel={t('lines.vehicleFilterReset')}
              lockedLabel={locked === null ? undefined : modeLabel(locked)}
              lockedHint={t('lines.vehicleFilterLockedHint')}
            />
          </View>
        </ScrollHeader>
      </View>

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
    marginBottom: Space.md,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Layout.pageInset,
    paddingBottom: Space.lg,
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
  rowSpinner: {
    paddingVertical: Space.none,
  },
});
