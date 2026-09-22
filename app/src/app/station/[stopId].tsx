import { BottomSheetFlatList, type BottomSheetFlatListMethods } from '@gorhom/bottom-sheet';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { useRouteShape } from '@/api/lines';
import { DEPARTURES_WINDOW_MINUTES, useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useStop } from '@/api/stops';
import { useTrip } from '@/api/trips';
import type { Departure, LiveVehicle } from '@/api/types';
import { useVehicles } from '@/api/vehicles';
import { Collapsible } from '@/components/collapsible';
import { LineBadge } from '@/components/line-badge';
import { LiveIndicator } from '@/components/live-indicator';
import { stationKindOf } from '@/components/station-icon';
import { MapScreen } from '@/components/map-screen';
import { useMapSheetEdgePadding } from '@/components/map-sheet';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { firstRelevantStopIndex } from '@/features/lines/first-relevant-stop';
import { PreviousStopsRow } from '@/features/lines/previous-stops-row';
import { StopSpineRow } from '@/features/lines/stop-spine';
import { formatHeadsign, tripNumberOf } from '@/features/results/itinerary-facts';
import { StationMap } from '@/features/stations/station-map';
import {
  departureKey, highlightMarkers, lineDepartures, lineKey, runStops,
} from '@/features/stations/station-line';
import { stationLines, stationTripIds, stationVehicleMarkers } from '@/features/stations/station-vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { departureTime } from '@/lib/departure-time';
import { formatClockTime, formatDurationMinutes, formatRelativeDay } from '@/lib/format';
import { routeColor } from '@/lib/route-color';

// A full board, not the home screen's short "next few" chip row. The window
// is the same `DEPARTURES_WINDOW_MINUTES` either way; only how many of that
// window's departures are shown differs.
const DEPARTURES_LIMIT = 50;

/** A line badge's ring when that line is the one in focus. */
const SELECTED_RING = 2;
/** The strip's other badges while a line is in focus: still there to switch to. */
const UNSELECTED_BADGE_OPACITY = 0.45;
/** GTFS `route_type` for rail. */
const RAIL_ROUTE_TYPE = 2;

function secondsUntil(iso: string, now: Date): number {
  return Math.max(0, (new Date(iso).getTime() - now.getTime()) / 1000);
}

/**
 * The stops of the departure that is open on the board: timed as this run
 * calls at them, this station marked, and the stops before it folded away --
 * or before wherever the bus has already reached, when that is further on.
 * Mounted per open departure, so the fold starts closed for each one.
 */
function RunStops(
  { departure, stationId, bus, now }: {
    departure: Departure; stationId: string | undefined; bus: LiveVehicle | null; now: Date;
  },
) {
  const { t, i18n } = useTranslation();
  const color = routeColor(departure.route);
  const { data: trip, isLoading } = useTrip(departure.tripId, i18n.language);
  // As the board shows it: live when the bus reports, so a late bus's stops
  // after this one read late too, and its row and this stop's time agree.
  const time = departureTime(departure.departureTime, departure.realtime).iso;
  const run = useMemo(
    () => runStops(trip, { stopId: departure.stopId, stopSequence: departure.stopSequence, departureTime: time }),
    [trip, departure.stopId, departure.stopSequence, time],
  );
  const [unfolded, setUnfolded] = useState(false);

  if (isLoading) return <View style={styles.runStatus}><ActivityIndicator /></View>;
  if (run.stops.length === 0) {
    return <ThemedText type="small" themeColor="textSecondary" style={styles.runStatus}>{t('line.error')}</ThemedText>;
  }

  // An unscheduled run's trip is only its template: no position to trust.
  const firstIndex = firstRelevantStopIndex({
    stops: run.stops.map((s) => ({ lat: s.lat, lon: s.lon, time: s.time })),
    boardingIndex: run.boardingIndex,
    bus: bus === null || departure.unscheduled ? null : { lat: bus.lat, lon: bus.lon },
    now,
  });
  const hiddenCount = unfolded ? 0 : firstIndex;

  return (
    <View style={styles.runStops}>
      {hiddenCount > 0 && <PreviousStopsRow count={hiddenCount} color={color} onPress={() => setUnfolded(true)} />}
      {run.stops.slice(hiddenCount).map((stop, visibleIndex) => {
        const index = visibleIndex + hiddenCount;
        return (
          <StopSpineRow
            key={`${index}:${stop.stopId}`}
            stop={{ key: `${index}:${stop.stopId}`, name: stop.name, time: stop.time }}
            color={color}
            boarding={index === run.boardingIndex}
            passed={run.boardingIndex > 0 && index < run.boardingIndex}
            first={index === 0}
            last={index === run.stops.length - 1}
            // Another stop's own board; this one is already open.
            onPress={stop.stopId === stationId
              ? undefined
              : () => router.push({ pathname: '/station/[stopId]', params: { stopId: stop.stopId, name: stop.name } })}
          />
        );
      })}
    </View>
  );
}

/** One departure on the board. Tapping it opens it in place -- its stops
 *  below it, its line's path on the map -- and tapping it again closes it. */
function DepartureRow(
  { departure, showLive, now, expanded, stationId, bus, onPress }: {
    departure: Departure;
    showLive: boolean;
    now: Date;
    expanded: boolean;
    stationId: string | undefined;
    bus: LiveVehicle | null;
    onPress: () => void;
  },
) {
  const { t } = useTranslation();
  const theme = useTheme();
  const time = departureTime(departure.departureTime, departure.realtime);
  const live = showLive && time.live;
  const trainNumber = tripNumberOf(departure);
  // The quiet line under the destination. A train's number goes here, not in
  // the destination's place: the rider picks the train by where it ends, and
  // the number only confirms it against the station's own display.
  const secondary = [
    trainNumber === null ? null : t('results.trainNumber', { number: trainNumber }),
    // A live bus off the timetable: said quietly, so a rider comparing with a
    // printed timetable doesn't read it as a mistake.
    departure.unscheduled ? t('station.unscheduled') : null,
  ].filter((part): part is string => part !== null).join(' · ');

  return (
    <View>
      <Pressable onPress={onPress} accessibilityState={{ expanded }} style={styles.row}>
        <LineBadge route={departure.route} />

        <View style={styles.headsign}>
          {/* Through `formatHeadsign`, same as every other surface that shows
              one -- this board was rendering the raw feed value, underscore
              separator and all. */}
          <ThemedText type={expanded ? 'smallBold' : 'default'} numberOfLines={1}>
            {formatHeadsign(departure.headsign)}
          </ThemedText>
          {secondary !== '' && (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              {secondary}
            </ThemedText>
          )}
        </View>

        <View style={styles.timeColumn}>
          <View style={styles.timeRow}>
            {live && <LiveIndicator color={theme.success} size={11} />}
            <ThemedText type="smallBold" style={live ? { color: theme.success } : undefined}>
              {formatDurationMinutes(secondsUntil(time.iso, now))}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {formatClockTime(time.iso)}
          </ThemedText>
        </View>
      </Pressable>

      <Collapsible open={expanded}>
        <RunStops departure={departure} stationId={stationId} bus={bus} now={now} />
      </Collapsible>
    </View>
  );
}

/**
 * The board is empty. Says WHY, not just that.
 *
 * Most of this feed does not run on Shabbat, so for roughly a day in seven
 * "no buses in the next hour" is the answer at every stop in the country --
 * true, and indistinguishable from a stop that is broken or withdrawn. The
 * next real departure resolves it in one line, and the API looks it up
 * (`nextDeparture`) precisely when the board comes back empty.
 */
function EmptyBoard({ next }: { next: Departure | null }) {
  const { t } = useTranslation();

  if (next === null) {
    return (
      <View style={styles.centered}>
        <ThemedText type="default" style={styles.centeredText}>{t('station.noService')}</ThemedText>
      </View>
    );
  }

  return (
    <View style={styles.centered}>
      <ThemedText type="default" style={styles.centeredText}>
        {t('station.empty', { minutes: DEPARTURES_WINDOW_MINUTES })}
      </ThemedText>
      <View style={styles.nextRow}>
        <ThemedText type="small" themeColor="textSecondary">
          {t('station.nextService', {
            day: formatRelativeDay(next.departureTime),
            time: formatClockTime(next.departureTime),
          })}
        </ThemedText>
        <LineBadge route={next.route} size="small" />
      </View>
    </View>
  );
}

/** The line in focus, and which of its departures is open on the board. */
type Highlight = { key: string; departureKey: string | null };

/**
 * The station page: a full-screen map centred on the stop, with the buses
 * heading to it, and the departure board in a drawer over the map.
 *
 * A line is put in FOCUS here rather than opened on a page of its own -- by
 * tapping its badge, one of its departures, or one of its buses. Its path is
 * drawn on the map and every other line's buses step back, while the map
 * itself stays exactly where the rider has it. The board stays the board: the
 * departure opens in place with its stops below it, and the line's other
 * departures are still in the list, in time order. Tapping the departure or
 * the badge again closes it.
 */
export default function StationScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { stopId, name } = useLocalSearchParams<{ stopId?: string; name?: string }>();
  const showLive = useRealtimeAvailable();
  // ONE clock for the whole board, not one per row -- a countdown must keep
  // counting even when the data behind it does not change. React Query hands
  // back the SAME object when a refetch finds an identical board (structural
  // sharing), which produces no re-render at all, so a board that reads
  // `Date.now()` at render time freezes on whatever minute it first drew.
  const now = useNow();
  const listRef = useRef<BottomSheetFlatListMethods>(null);

  const { data: stop } = useStop(stopId ?? null, i18n.language);
  const { data, isLoading, isError } = useStopDepartures(stopId ?? null, DEPARTURES_LIMIT, i18n.language);
  const departures = useMemo(() => data?.departures ?? [], [data]);

  const tripIds = useMemo(() => stationTripIds(departures), [departures]);
  const { data: live } = useVehicles(tripIds);
  const stationVehicles = useMemo(
    () => stationVehicleMarkers(departures, live?.vehicles ?? [], now),
    [departures, live, now],
  );
  const lines = useMemo(() => stationLines(stop?.routes ?? []), [stop]);

  // --- The line in focus ----------------------------------------------------

  const [highlight, setHighlight] = useState<Highlight | null>(null);
  // The open departure while it is still on the board. Once it has left, the
  // line stays in focus with nothing open: the board must not jump to another.
  const selected = highlight === null
    ? null
    : departures.find((d) => departureKey(d) === highlight.departureKey) ?? null;
  // The path to draw: the open departure's, or else the line's next one here.
  const pathDeparture = selected ?? (highlight === null ? null : lineDepartures(departures, highlight.key)[0] ?? null);

  const { data: shape } = useRouteShape(pathDeparture?.route.routeId ?? null, pathDeparture?.directionId ?? 0);
  const pathColor = pathDeparture ? routeColor(pathDeparture.route) : null;
  const route = useMemo(() => {
    if (highlight === null || pathColor === null || !shape) return null;
    // GeoJSON puts longitude first; the map wants latitude, named.
    const coordinates = shape.geometry.coordinates.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
    return coordinates.length > 1 ? { coordinates, color: pathColor, dashed: shape.geometryFallback } : null;
  }, [highlight, pathColor, shape]);

  const vehicles = useMemo(
    () => (highlight === null ? stationVehicles : highlightMarkers(stationVehicles, departures, highlight.key)),
    [stationVehicles, departures, highlight],
  );

  function toggleDeparture(departure: Departure) {
    const key = departureKey(departure);
    setHighlight(highlight?.departureKey === key ? null : { key: lineKey(departure.route), departureKey: key });
  }

  /** From a badge or a bus, whose departure may be far down the board: open
   *  it and bring its row to the top of the list. */
  function openFromOutside(key: string, departure: Departure | null) {
    setHighlight({ key, departureKey: departure ? departureKey(departure) : null });
    if (departure === null) return;
    const index = departures.indexOf(departure);
    if (index >= 0) listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
  }

  // The station frames in the part of the map above the drawer at rest.
  const edgePadding = useMapSheetEdgePadding();
  const center = stop ? { latitude: stop.lat, longitude: stop.lon } : null;
  // The sign by what calls there, as the API names it. An API older than that
  // leaves the stop's own route types to say whether trains call.
  const stationKind = stationKindOf({
    stationKind: stop?.stationKind,
    rail: stop?.routes.some((r) => r.type === RAIL_ROUTE_TYPE),
  });
  const title = name || stop?.name || stopId || '';

  // A fixed, short header however many lines call here: a busy stop serves
  // dozens, and wrapped badges pushed the departures below the drawer's peek.
  // The badges scroll sideways instead, edge to edge, their first one lined up
  // with the name. Gesture-handler's ScrollView, not React Native's: inside
  // the drawer, Android only lets a sideways swipe reach the strip when both
  // gestures go through the same handler system.
  const header = (
    <View style={styles.sheetHeader}>
      <ThemedText type="smallBold" numberOfLines={2} style={styles.title}>{title}</ThemedText>
      {lines.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.lineStrip}>
          {lines.map((line) => {
            const key = lineKey(line);
            const isSelected = highlight?.key === key;
            return (
              <Pressable
                key={line.routeId}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                onPress={() => (isSelected
                  ? setHighlight(null)
                  : openFromOutside(key, lineDepartures(departures, key)[0] ?? null))}
                style={[
                  styles.badgeSlot,
                  { borderColor: isSelected ? theme.text : 'transparent' },
                  highlight !== null && !isSelected && { opacity: UNSELECTED_BADGE_OPACITY },
                ]}
              >
                <LineBadge route={line} size="small" />
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  return (
    <MapScreen
      map={
        <StationMap
          center={center}
          title={title}
          kind={stationKind}
          vehicles={vehicles}
          onVehiclePress={(tripId) => {
            const departure = departures.find((d) => d.tripId === tripId);
            if (departure) openFromOutside(lineKey(departure.route), departure);
          }}
          edgePadding={edgePadding}
          route={route}
        />
      }
    >
      <BottomSheetFlatList
        ref={listRef}
        data={isLoading || isError ? [] : departures}
        // By run, not trip: an unscheduled bus shares its template trip's id.
        // Still paired with the time: the API can list one run twice on a board.
        keyExtractor={(item) => departureKey(item)}
        extraData={highlight}
        ListHeaderComponent={header}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.status}><ActivityIndicator /></View>
          ) : isError ? (
            <View style={styles.status}><ThemedText type="default">{t('station.error')}</ThemedText></View>
          ) : (
            <EmptyBoard next={data?.nextDeparture ?? null} />
          )
        }
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />
        )}
        renderItem={({ item }) => {
          const expanded = selected !== null && departureKey(item) === departureKey(selected);
          return (
            <DepartureRow
              departure={item}
              showLive={showLive}
              now={now}
              expanded={expanded}
              stationId={stopId}
              // For every row, not just the open one: a row closing keeps its
              // stops on screen while it shrinks, and they must not re-fold.
              bus={live?.vehicles.find((v) => v.tripId === item.tripId) ?? null}
              onPress={() => toggleDeparture(item)}
            />
          );
        }}
        // Rows are not all one height, so a row far down the board may not be
        // measured yet: jump near it, then try again once it has rendered.
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 }), 100);
        }}
        contentContainerStyle={styles.sheetContent}
      />
    </MapScreen>
  );
}

const styles = StyleSheet.create({
  // No side padding of its own: the badge strip scrolls edge to edge, so the
  // name and the strip's content each carry the header's inset instead.
  // Cluster spacing, not `SectionGap`: this is a sheet, and its peek is
  // the only part the rider sees without dragging it up.
  sheetHeader: {
    paddingTop: Spacing.one,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
  title: {
    paddingHorizontal: Spacing.four,
  },
  lineStrip: {
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
  },
  // A ring the width of the selected border on every badge, transparent until
  // selected, so choosing a line does not shift the strip.
  badgeSlot: {
    borderWidth: SELECTED_RING,
    borderRadius: Spacing.two,
    padding: 1,
  },
  runStops: {
    paddingBottom: Spacing.four,
  },
  runStatus: {
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  status: {
    alignItems: 'center',
    paddingVertical: Spacing.five,
  },
  sheetContent: {
    paddingBottom: Spacing.five,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
    gap: Spacing.two,
  },
  centeredText: {
    textAlign: 'center',
  },
  nextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
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
  headsign: {
    flex: 1,
  },
  timeColumn: {
    alignItems: 'flex-end',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.four,
  },
});
