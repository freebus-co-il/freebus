import { BottomSheetFlatList, type BottomSheetFlatListMethods } from '@gorhom/bottom-sheet';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { MapSchemeScope } from '@/components/map-scheme-scope';
import { useRouteShape } from '@/api/lines';
import { DEPARTURES_WINDOW_MINUTES, STATION_BOARD_LIMIT, useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useStop } from '@/api/stops';
import { useTrip } from '@/api/trips';
import type { Departure, LiveVehicle } from '@/api/types';
import { useVehicles } from '@/api/vehicles';
import { Collapsible } from '@/components/collapsible';
import { LineBadge } from '@/components/line-badge';
import { LiveIndicator } from '@/components/live-indicator';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { MapScreen } from '@/components/map-screen';
import { useMapSheetEdgePadding } from '@/components/map-sheet';
import {
  Border, Chip, EmptyState, IconButton, Layout, Loading, Opacity, Radius, Separator, Size, Space, Text, useColors,
} from '@/design-system';
import { firstRelevantStopIndex } from '@/features/lines/first-relevant-stop';
import { usePreferences } from '@/features/preferences/preferences-context';
import { PreviousStopsRow } from '@/features/lines/previous-stops-row';
import { StopSpineRow } from '@/features/lines/stop-spine';
import { formatHeadsign, tripNumberOf } from '@/features/results/itinerary-facts';
import { fastestArrivalKey } from '@/features/stations/destination-board';
import { takeDestination, type PickedDestination } from '@/features/stations/destination-handoff';
import { routePath } from '@/features/stations/route-path';
import { routeStopDots } from '@/features/stations/route-stops';
import { StationMap } from '@/features/stations/station-map';
import {
  departureKey, highlightMarkers, lineDepartures, lineKey, runStops,
} from '@/features/stations/station-line';
import { stationLines, stationTripIds, stationVehicleMarkers } from '@/features/stations/station-vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { departureTime } from '@/lib/departure-time';
import { formatClockTime, formatDurationMinutes, formatRelativeDay } from '@/lib/format';
import { routeColor } from '@/lib/route-color';

// A full board, not the home screen's short "next few" chip row. The window
// is the same `DEPARTURES_WINDOW_MINUTES` either way; only how many of that
// window's departures are shown differs.
const DEPARTURES_LIMIT = STATION_BOARD_LIMIT;

/** Where the hairline between two departures starts: clear of the line
 *  badge, under the destination -- the iOS list convention. */
const ROW_SEPARATOR_INSET = Layout.rowPaddingH + Size.leadingTile + Space.md;
/** GTFS `route_type` for rail. */
const RAIL_ROUTE_TYPE = 2;

/**
 * How far from the destination a run has to set the rider down before the
 * row says so.
 *
 * The server counts any stop within 500 m as arriving, which is what lets a
 * rider name a railway station instead of the bus stop outside it. Most of
 * the time that stop IS the place and there is nothing to report; past this
 * much it is a walk the rider should know about before boarding.
 */
const WALK_WORTH_SAYING = 150;

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

  // Inline under the open row, not an `EmptyState`: the board is still the
  // board, and a centred block would push the rows below off the peek.
  if (isLoading) return <Loading style={styles.runStatus} />;
  if (run.stops.length === 0) {
    return <Text variant="subheadline" color="textSecondary" style={styles.runStatus}>{t('line.error')}</Text>;
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
  { departure, showLive, now, expanded, stationId, bus, fastest, onPress }: {
    departure: Departure;
    showLive: boolean;
    now: Date;
    expanded: boolean;
    stationId: string | undefined;
    bus: LiveVehicle | null;
    /** This run reaches the filtered destination before every other row on
     *  the board, and is not the first to leave -- see `fastestArrivalKey`. */
    fastest: boolean;
    onPress: () => void;
  },
) {
  const { t } = useTranslation();
  const colors = useColors();
  const { timeFormat } = usePreferences();
  const time = departureTime(departure.departureTime, departure.realtime);
  const live = showLive && time.live;
  const countdown = formatDurationMinutes(secondsUntil(time.iso, now));
  const clock = formatClockTime(time.iso);
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

  // Present on every row of a board filtered to a destination, and on none
  // of an unfiltered one. Where the arrival is the EARLIEST on the board it
  // is said with weight instead of quietly -- the row is further down than
  // the bus that leaves first, and nothing else on a time-ordered board
  // would tell the rider that this is the one to wait for.
  const arrival = departure.destination === undefined
    ? null
    : t(fastest ? 'station.arrivesFirst' : 'station.arrivesAt', {
      time: formatClockTime(departure.destination.arrivalTime),
    });

  // The destination is a PLACE, and the stop this run calls at may be a few
  // minutes' walk from it -- so "arrives 07:52" would otherwise quietly
  // promise a door it does not reach. Said only past `WALK_WORTH_SAYING`:
  // below that the stop is effectively the place, and a distance on every
  // row would be noise that trains the rider to stop reading the line.
  const walkMeters = departure.destination?.walkMeters;
  const walk = walkMeters !== undefined && walkMeters >= WALK_WORTH_SAYING
    ? t('station.thenWalk', { meters: walkMeters })
    : null;

  return (
    <View>
      {/* `ListRow`'s shape and pressed state, built here because the row has
          to tell a screen reader it is expanded -- which `ListRow` cannot. */}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        android_ripple={{ color: colors.fillPressed }}
        style={({ pressed }) => [styles.row, pressed && Platform.OS === 'ios' && { backgroundColor: colors.fillPressed }]}
      >
        <View style={styles.leading}>
          <LineBadge route={departure.route} />
        </View>

        <View style={styles.headsign}>
          {/* Through `formatHeadsign`, same as every other surface that shows
              one -- this board was rendering the raw feed value, underscore
              separator and all. */}
          <Text variant={expanded ? 'headline' : 'body'} numberOfLines={1}>
            {formatHeadsign(departure.headsign)}
          </Text>
          {secondary !== '' && (
            <Text variant="subheadline" color="textSecondary" numberOfLines={1} numeric>
              {secondary}
            </Text>
          )}
          {arrival !== null && (
            <Text
              variant="subheadline"
              emphasized={fastest}
              color={fastest ? 'textPrimary' : 'textSecondary'}
              numberOfLines={1}
              numeric
            >
              {walk === null ? arrival : `${arrival} · ${walk}`}
            </Text>
          )}
        </View>

        <View style={styles.timeColumn}>
          <View style={styles.timeRow}>
            {live && <LiveIndicator color={colors.live} size={Size.icon.xs} />}
            <Text variant="headline" numeric color={live ? 'live' : 'textPrimary'}>
              {timeFormat === 'clock' ? clock : countdown}
            </Text>
          </View>
          {/* Both, with the rider's choice on top: a board is where the
              other form is still worth a glance. */}
          <Text variant="footnote" color="textSecondary" numeric>
            {timeFormat === 'clock' ? countdown : clock}
          </Text>
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
function EmptyBoard({ next, destinationName }: {
  next: Departure | null;
  /** Set when the board was filtered to a destination -- then an empty board
   *  is not a fact about the stop at all, and the lookahead below (which
   *  answers "is this stop served") is deliberately withheld by the API. */
  destinationName: string | null;
}) {
  const { t } = useTranslation();

  if (destinationName !== null) {
    return (
      <EmptyState
        icon="pin"
        title={t('station.noneToDestination', {
          name: destinationName, minutes: DEPARTURES_WINDOW_MINUTES,
        })}
      />
    );
  }

  if (next === null) {
    return <EmptyState icon="calendar" title={t('station.noService')} />;
  }

  // The next departure carries its line's badge, which `EmptyState` has no
  // slot for: the state's own block, then the badge line tucked under it.
  return (
    <View style={styles.emptyWithNext}>
      <EmptyState icon="time" title={t('station.empty', { minutes: DEPARTURES_WINDOW_MINUTES })} style={styles.emptyTop} />
      <View style={styles.nextRow}>
        <Text variant="subheadline" color="textSecondary" numeric>
          {t('station.nextService', {
            day: formatRelativeDay(next.departureTime),
            time: formatClockTime(next.departureTime),
          })}
        </Text>
        <LineBadge route={next.route} size="small" />
      </View>
    </View>
  );
}

/** The line in focus, and which of its departures is open on the board. */
type Highlight = { key: string; departureKey: string | null };

/**
 * The board's destination filter: the one control on this screen that
 * changes WHICH buses are listed rather than which one is in focus.
 *
 * Unset it is an ordinary menu chip: it opens a choice (the destination
 * picker). Set, it is a selected chip -- the `accent` fill, the app's one way
 * of drawing a control that is doing something, and worth the weight here
 * because a filtered board is a board that is hiding rows, which the rider
 * must never have to deduce from a short list.
 */
function DestinationFilter(
  { destination, onPick, onClear }: {
    destination: PickedDestination | null;
    onPick: () => void;
    onClear: () => void;
  },
) {
  const { t } = useTranslation();

  if (destination === null) {
    return (
      <View style={styles.filterRow}>
        <Chip icon="pin" label={t('station.filterPrompt')} menu onPress={onPick} />
      </View>
    );
  }

  return (
    <View style={styles.filterRow}>
      <Chip
        icon="pin"
        label={t('station.filterTo', { name: destination.name })}
        selected
        onPress={onPick}
        style={styles.filterFill}
      />
      <IconButton
        icon="close"
        variant="plain"
        size="sm"
        color="textSecondary"
        accessibilityLabel={t('station.filterClear')}
        onPress={onClear}
      />
    </View>
  );
}

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
 *
 * Painted in the map's scheme (`MapSchemeScope`): it sits on the map.
 */
export default function StationScreen() {
  return (
    <MapSchemeScope screen>
      <StationScreenContent />
    </MapSchemeScope>
  );
}

function StationScreenContent() {
  const { t, i18n } = useTranslation();
  const colors = useColors();
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

  // --- The destination the board is filtered to ---------------------------
  //
  // This screen's own state, and it dies with the screen: tapping a stop
  // further down a run opens a NEW board, which is a fresh question about a
  // different place and starts unfiltered.
  const [destination, setDestination] = useState<PickedDestination | null>(null);

  const { data, isLoading, isError } = useStopDepartures(
    stopId ?? null, DEPARTURES_LIMIT, i18n.language,
    destination === null ? null : { lat: destination.lat, lon: destination.lon },
  );
  const departures = useMemo(() => data?.departures ?? [], [data]);

  const tripIds = useMemo(() => stationTripIds(departures), [departures]);
  const { data: live } = useVehicles(tripIds);
  const stationVehicles = useMemo(
    () => stationVehicleMarkers(departures, live?.vehicles ?? [], now),
    [departures, live, now],
  );
  // Filtered, the strip is built from the BOARD rather than from the stop:
  // a strip still offering every line that calls here would put badges above
  // a board that cannot show a single one of their departures.
  const lines = useMemo(
    () => (destination === null
      ? stationLines(stop?.routes ?? [])
      : stationLines(departures.map((d) => d.route))),
    [stop, departures, destination],
  );

  // --- The line in focus ----------------------------------------------------

  const [highlight, setHighlight] = useState<Highlight | null>(null);

  /** Changing the destination changes which lines exist on this board, so a
   *  line held in focus from the previous one has to let go. */
  function applyDestination(next: PickedDestination | null) {
    setDestination(next);
    setHighlight(null);
  }

  // The station picked on the screen this board opened, taken on the way
  // back -- see `destination-handoff`. The two setters are React's own and
  // never change, so this callback can be built once and the board is not
  // re-subscribed on every render.
  useFocusEffect(
    useCallback(() => {
      const picked = takeDestination();
      if (picked === null) return;
      setDestination(picked);
      setHighlight(null);
    }, []),
  );

  // Null on an unfiltered board, and on a filtered one whose first departure
  // is already its first arrival -- see `fastestArrivalKey`.
  const fastestKey = useMemo(() => fastestArrivalKey(departures), [departures]);
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
    return routePath(shape, pathColor);
  }, [highlight, pathColor, shape]);

  // The run the path is drawn for, dotted at each of its stops. The open
  // departure's own trip is already being fetched for its stop list below, so
  // this is usually a cache hit, not a second request.
  const { data: pathTrip } = useTrip(highlight === null ? null : pathDeparture?.tripId ?? null, i18n.language);
  const stopDots = useMemo(() => {
    if (highlight === null || pathDeparture === null) return [];
    const run = runStops(pathTrip, {
      stopId: pathDeparture.stopId,
      stopSequence: pathDeparture.stopSequence,
      departureTime: pathDeparture.departureTime,
    });
    return routeStopDots(run.stops, run.boardingIndex);
  }, [highlight, pathDeparture, pathTrip]);

  // Back lets go of the line in focus before it leaves the board: picking a
  // line is a step INTO this screen, and the way out of a step is back. The
  // header chip and Android's own back button agree; iOS's edge swipe stays
  // the native pop the platform promises.
  const clearHighlight = useCallback(() => {
    if (highlight === null) return false;
    setHighlight(null);
    return true;
  }, [highlight]);
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', clearHighlight);
      return () => subscription.remove();
    }, [clearHighlight]),
  );

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
      <View style={styles.titleRow}>
        <StationIcon kind={stationKind} />
        <Text variant="title2" numberOfLines={2} style={styles.title}>{title}</Text>
      </View>
      {/* Above the line strip, because it governs it: with a destination set
          the strip below lists only the lines that actually go there. */}
      <DestinationFilter
        destination={destination}
        onPick={() => router.push('/station/destination-picker')}
        onClear={() => applyDestination(null)}
      />
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
                android_ripple={{ color: colors.fillPressed, borderless: true }}
                style={({ pressed }) => [
                  styles.badgeSlot,
                  { borderColor: isSelected ? colors.accent : 'transparent' },
                  // The strip's other badges while a line is in focus: still
                  // there to switch to.
                  highlight !== null && !isSelected && { opacity: Opacity.dimmed },
                  pressed && Platform.OS === 'ios' && { opacity: Opacity.pressed },
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
      onBack={clearHighlight}
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
          stops={stopDots}
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
            <Loading />
          ) : isError ? (
            <EmptyState icon="error" title={t('station.error')} />
          ) : (
            <EmptyBoard
              next={data?.nextDeparture ?? null}
              destinationName={destination?.name ?? null}
            />
          )
        }
        ItemSeparatorComponent={RowSeparator}
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
              fastest={fastestKey !== null && departureKey(item) === fastestKey}
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

/** Between two departures. Module-level, so the list is not handed a new
 *  component -- and does not remount every separator -- on each render. */
function RowSeparator() {
  return <Separator insetStart={ROW_SEPARATOR_INSET} />;
}

const styles = StyleSheet.create({
  // No side padding of its own: the badge strip scrolls edge to edge, so the
  // name and the strip's content each carry the header's inset instead.
  // Cluster spacing, not `Layout.sectionGap`: this is a sheet, and its peek
  // is the only part the rider sees without dragging it up.
  sheetHeader: {
    paddingTop: Space.xs,
    paddingBottom: Space.lg,
    gap: Space.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Layout.pageInset,
  },
  title: {
    flex: 1,
  },
  // The filter sits between the name and the line strip -- a cluster of
  // controls under a heading, not three sections of a page.
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Layout.pageInset,
  },
  // Shrinks rather than pushing the clear button off the row: a station name
  // can be long, and the way out of a filter must never be what gets cut.
  filterFill: {
    flexShrink: 1,
  },
  lineStrip: {
    gap: Space.xs,
    paddingHorizontal: Layout.pageInset - Border.selected - Space.xxs,
    alignItems: 'center',
  },
  // A ring the width of the selected border on every badge, transparent until
  // selected, so choosing a line does not shift the strip. The strip's inset
  // above is trimmed by the ring and its gap, so the badges themselves line
  // up with the name.
  badgeSlot: {
    borderWidth: Border.selected,
    borderRadius: Radius.sm,
    padding: Space.xxs,
  },
  runStops: {
    paddingBottom: Space.md,
  },
  runStatus: {
    paddingVertical: Space.md,
    paddingHorizontal: Layout.pageInset,
  },
  sheetContent: {
    paddingBottom: Space.xxxl,
  },
  emptyWithNext: {
    alignItems: 'center',
    paddingBottom: Space.huge,
  },
  // The badge line below takes the state's bottom air instead.
  emptyTop: {
    paddingBottom: Space.sm,
  },
  nextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  // `ListRow`'s padding: a board runs to dozens of rows and is scanned, so
  // never the home screen's looser rhythm.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Layout.rowPaddingV,
    paddingHorizontal: Layout.rowPaddingH,
  },
  leading: {
    minWidth: Size.leadingTile,
    alignItems: 'center',
  },
  headsign: {
    flex: 1,
    gap: Space.xxs,
  },
  timeColumn: {
    alignItems: 'flex-end',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
