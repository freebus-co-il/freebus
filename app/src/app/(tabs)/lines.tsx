import { IconBuildingCommunity, IconBus, IconSearch } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAgencies } from '@/api/agencies';
import { useRouteSearch } from '@/api/lines';
import { useTransitModes } from '@/api/modes';
import { useNearbyStops } from '@/api/stops';
import type { StopRouteBrief } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SectionGap, Spacing } from '@/constants/theme';
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
import { FieldShell } from '@/features/search/field-shell';
import { useSearch } from '@/features/search/search-context';
import { useTheme } from '@/hooks/use-theme';
import { INPUT_ALIGN_START } from '@/i18n/direction';

/** The location picker's pause, kept identical -- see `stations.tsx`. */
const SEARCH_DEBOUNCE_MS = 275;

/** Nearby badges before the strip stops earning its space. It is a summary of
 *  what runs past the rider, not a list to read through; past this many the
 *  row wraps and starts competing with the lines below it. */
const MAX_NEARBY_BADGES = 12;

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

/** One line, as the badge a rider recognises plus where it goes. */
function LineRow({ line, onPress }: { line: LineSummary; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      {/* No `color`: `LineBadge` fills from the OPERATOR, not from the feed's
          per-route colour, so its route shape has no colour field to pass. */}
      <LineBadge route={{ shortName: line.shortName, agencyId: line.agencyId, type: line.type }} />
      <ThemedText type="default" numberOfLines={1} style={styles.rowText}>
        {line.longName ?? ''}
      </ThemedText>
    </Pressable>
  );
}

/**
 * Every line in the feed, searchable, filterable and browsable.
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
  const theme = useTheme();
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

  const { data, fetchNextPage, hasNextPage, isFetching } = useRouteSearch(debouncedQuery, {
    agencies: selectedAgencies,
    types,
    excludeTypes: [RAIL_TYPE],
  });

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
  const { data: nearbyData } = useNearbyStops(here && { lat: here.lat, lon: here.lon }, i18n.language);

  // Deduped on number-plus-operator, which is all these briefs carry. They
  // have NO route id and no line code, so a nearby badge cannot be tapped
  // through to a line page -- this is a summary of what is around, and
  // deliberately not a navigable list. See the strip below.
  const nearbyLines = useMemo(() => {
    const seen = new Map<string, StopRouteBrief>();
    for (const stop of nearbyData?.stops ?? []) {
      // `?? []`: absent, not merely empty, on an API older than this tab.
      for (const route of stop.routes ?? []) {
        seen.set(`${route.shortName}:${route.agencyId ?? ''}`, route);
      }
    }
    return [...seen.values()].slice(0, MAX_NEARBY_BADGES);
  }, [nearbyData]);

  const searching = debouncedQuery.trim() !== '';

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

  // Only while browsing: a search is a list of answers, and prefixing it with
  // recents and nearby would bury the ones the rider actually asked for.
  const header = searching ? null : (
    <View style={styles.header}>
      {recents.length > 0 && (
        <View style={styles.section}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            {t('lines.recent')}
          </ThemedText>
          <View>
            {recents.map((line, index) => (
              <Fragment key={line.lineCode}>
                {index > 0 && <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />}
                <LineRow line={line} onPress={() => openLine(line)} />
              </Fragment>
            ))}
          </View>
        </View>
      )}

      {nearbyLines.length > 0 && (
        <View style={styles.stripSection}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            {t('lines.nearby')}
          </ThemedText>
          {/* Not pressable, by construction: `/stops/nearby` returns line
              briefs with no route id and no line code, so there is nothing to
              open. Making them look tappable would promise a page we cannot
              address. */}
          <View style={styles.nearbyStrip}>
            {nearbyLines.map((route) => (
              <LineBadge key={`${route.shortName}:${route.agencyId ?? ''}`} route={route} size="small" />
            ))}
          </View>
        </View>
      )}

      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.allHeading}>
        {t('lines.all')}
      </ThemedText>
    </View>
  );

  return (
    <ThemedView type="background" style={styles.container}>
      {/* Top edge only, like the other tabs -- the tab bar already clears the
          home indicator. */}
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ThemedText type="title" style={styles.heading}>
          {t('lines.title')}
        </ThemedText>

        <View style={styles.field}>
          <FieldShell>
            <IconSearch size={18} color={theme.text} />
            <TextInput
              style={[styles.input, { color: theme.text }, Platform.OS === 'web' && styles.inputWebNoOutline]}
              placeholder={t('lines.search')}
              placeholderTextColor={theme.textSecondary}
              value={query}
              onChangeText={setQuery}
            />
          </FieldShell>
        </View>

        {/* Two chips, side by side, each opening its own drawer. No
            horizontal ScrollView: two pills fit any phone, and wrapping them
            in one is what squeezed their labels down to a single glyph. */}
        <View style={styles.filterRow}>
          <LineFilterChip
            icon={<IconBuildingCommunity size={18} color={theme.text} />}
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
            icon={<IconBus size={18} color={locked === null ? theme.text : theme.textSecondary} />}
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

        <FlatList
          data={lines}
          keyExtractor={(item) => item.lineCode}
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
                {t('lines.empty')}
              </ThemedText>
            ) : null
          }
          renderItem={({ item }) => <LineRow line={item} onPress={() => openLine(item)} />}
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
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
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
  // The badge strip is not a list of rows and brings no padding with it,
  // so its heading still has to hold itself off.
  stripSection: {
    gap: Spacing.three,
  },
  sectionTitle: {
    paddingHorizontal: Spacing.four,
  },
  nearbyStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
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
