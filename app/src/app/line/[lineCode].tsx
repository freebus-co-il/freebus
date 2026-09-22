import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { useLine, useRouteRuns, useRouteShape } from '@/api/lines';
import { useTrip } from '@/api/trips';
import { useRouteVehicles, useVehicles } from '@/api/vehicles';
import type { LineDetail, LineDirection, Place, RouteRun } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { MapScreen } from '@/components/map-screen';
import { useMapSheetEdgePadding } from '@/components/map-sheet';
import { SegmentedControl } from '@/components/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { LineMap, type MapPin } from '@/features/lines/line-map';
import { alignStopTimesToRun, firstRelevantStopIndex } from '@/features/lines/first-relevant-stop';
import { PreviousStopsRow } from '@/features/lines/previous-stops-row';
import { runNeighbours } from '@/features/lines/run-neighbours';
import { activeRun, shiftIso } from '@/features/lines/run-times';
import { StopSpineRow } from '@/features/lines/stop-spine';
import { useRecents } from '@/features/recents/recents-context';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { lineVehicleMarkers } from '@/features/results/vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { formatClockTime } from '@/lib/format';
import { routeColor } from '@/lib/route-color';

/** A direction's headsign is a whole "city_place<->city_place" string; a
 *  segment of a three-way switch has room for a name, not a sentence. */
const DIRECTION_LABEL_MAX = 18;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The headsign as a rider reads it, or `''` when the feed gives this
 *  direction no sign at all -- callers fall back to the line's own long name,
 *  the same fallback the run page's header draws. */
function directionName(direction: LineDirection | null): string {
  const headsign = direction?.headsign?.trim() ?? '';
  return headsign === '' ? '' : formatHeadsign(headsign);
}

function LineHeader({ line, direction }: { line: LineDetail; direction: LineDirection | null }) {
  const { t } = useTranslation();
  const towards = directionName(direction);

  return (
    <View style={styles.lineHeader}>
      <LineBadge route={{ shortName: line.shortName, agencyId: line.agencyId, type: line.type }} />
      <View style={styles.lineHeaderText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {towards === '' ? (line.longName ?? '') : t('line.direction', { name: towards })}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {t('line.stopCount', { count: direction?.stops.length ?? 0 })}
        </ThemedText>
      </View>
    </View>
  );
}

/**
 * A whole line: a full-screen map of its direction with buses on the road,
 * and the page content -- direction toggle, next runs, and the stop list --
 * in the drawer over it.
 *
 * Reached from the Lines tab, and the counterpart to `run/[tripId]`: that page
 * is one vehicle, this one is the line itself. The distinction the feed forces
 * on us is that a "line" is not a route row -- it is one row per direction per
 * alternative -- so the direction toggle is keyed on `route_desc`'s direction
 * digit and never on GTFS `direction_id`, which maps digits 1 and 3 onto the
 * same value and would make the toggle jump between two distinct directions.
 *
 * Times come from whichever run is selected rather than from a second
 * departures query, so the times and the stop list can never disagree; when
 * there are no runs at all -- Shabbat, or after the last service -- the spine
 * still renders, timeless, with a line saying why. The line exists and its
 * path is still worth reading.
 *
 * The direction's path is drawn on the map, in the line's own colour so map
 * and spine agree. `GET /routes/:routeId/shape` answers in GeoJSON, whose
 * coordinates are `[lon, lat]`; they are flipped to `{ latitude, longitude }`
 * here, once, before the map sees them. The direction's buses on the road ride
 * on the same map, and tapping one opens its run.
 *
 * The stop list starts at `firstRelevantStopIndex` -- the later of the rider's
 * own stop and wherever the selected bus has reached -- with the stops before
 * it folded behind a "N previous stops" row the rider can unfold in place.
 *
 * Opened from a station board (`stopId`, `tripId`, `routeId` and `direction`
 * params), the page is about the rider's run instead: it opens on that
 * direction, the run chips are that stop's runs around the tapped one, the
 * spine follows the run's own stops with the rider's stop pinned on the map,
 * and the map shows only the rider's bus with the one ahead and the one
 * behind. Tapping a neighbour selects it here. Switching direction leaves that
 * mode -- the station only belongs to the direction it was opened on.
 */
export default function LineScreen() {
  const params = useLocalSearchParams<{
    lineCode?: string; direction?: string; stopId?: string; tripId?: string; routeId?: string;
  }>();
  const { lineCode } = params;
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const { recordLine } = useRecents();

  const { data: line, isLoading, isError } = useLine(lineCode ?? null, i18n.language);

  // The desc digit, never `directionId` -- two directions can share a
  // `directionId`, so keying selection on it would make the toggle jump
  // between them.
  const [direction, setDirection] = useState<string | null>(params.direction ?? null);
  const selected = line?.directions.find((d) => d.direction === direction)
    ?? line?.directions[0]
    ?? null;

  const selectedRouteId = selected?.routeId ?? null;

  // The station the page was opened from, while the rider is still on the
  // direction it belongs to. Its route is the departure's own -- possibly a
  // variant the line's representative row is not -- so runs, shape and
  // stops all follow it rather than `selectedRouteId`.
  const station = useMemo(
    () => (
      params.stopId && params.tripId && params.routeId
        && selected !== null && selected.direction === params.direction
        ? { stopId: params.stopId, tripId: params.tripId, routeId: params.routeId }
        : null
    ),
    [params.stopId, params.tripId, params.routeId, params.direction, selected],
  );
  const runsRouteId = station?.routeId ?? selectedRouteId;
  const { data: runs } = useRouteRuns(
    runsRouteId,
    i18n.language,
    station === null ? null : { stopId: station.stopId, tripId: station.tripId },
  );

  // A run belongs to one direction, so the pick carries the route it was made
  // on and is simply ignored once the direction moves off it. Held that way
  // rather than cleared by an effect keyed on the direction: an effect that
  // sets state renders the stale run once before dropping it, and the pick is
  // derivable from what is already on screen.
  // The picked run itself, not just its id: if it then leaves the refetched
  // list -- it departed, or an unscheduled bus's `runId` flipped -- its own
  // trip, offset and label stay on screen instead of the page jumping to
  // another run while the rider is reading it.
  const [pickedRun, setPickedRun] = useState<{ routeId: string; run: RouteRun } | null>(null);
  const heldRun = pickedRun !== null && pickedRun.routeId === runsRouteId
    ? pickedRun.run
    : null;
  // Defaults to the run the rider tapped on the board -- a timetable run, whose
  // `runId` is its `tripId` -- else to the first run, so the page opens already
  // answering "when does this reach my stop" rather than as a timeless list.
  const shownRun = useMemo(
    () => activeRun(runs?.runs ?? [], heldRun, station?.tripId ?? null),
    [runs, heldRun, station],
  );
  // Before the runs load, or when the board's trip is not among them, the
  // board's own trip still drives the page.
  const activeTripId = shownRun?.tripId ?? station?.tripId ?? null;
  const { data: trip } = useTrip(activeTripId, i18n.language);

  // Keyed on `directionId`, not on the desc digit: the shape endpoint speaks
  // GTFS, and this is the one place the two numbering schemes have to meet.
  // A variant shares its direction's GTFS `direction_id` -- both come from the
  // same desc digit -- so the selected direction's value holds for it too.
  const { data: shape } = useRouteShape(runsRouteId, selected?.directionId ?? 0);
  // GeoJSON puts longitude first; the map wants latitude, named. Memoized
  // because `LineMap` keys its camera fit on this array's identity -- rebuilt
  // every render, the fit would re-animate on every tick of the run list.
  const shapePath = useMemo(
    () => (shape?.geometry.coordinates ?? []).map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    })),
    [shape],
  );

  // The buses on the road in the SELECTED direction: each direction is its own
  // route, so flipping the toggle swaps the buses along with the path. Asked
  // by route rather than by run -- the runs above are the ones yet to start,
  // which are exactly the buses not on the map.
  //
  // From a station, only the rider's bus and its two neighbours instead.
  const neighbourTripIds = useMemo(
    () => (station === null ? [] : runNeighbours(runs?.runs ?? [], activeTripId)),
    [station, runs, activeTripId],
  );
  const { data: routeLive } = useRouteVehicles(selectedRouteId, { enabled: station === null });
  const { data: neighbourLive } = useVehicles(neighbourTripIds, { enabled: station !== null });
  const live = station === null ? routeLive : neighbourLive;
  // Ticks on its own so a dot's age keeps counting between polls.
  const now = useNow();
  const vehicles = useMemo(
    () => (
      line && live
        ? lineVehicleMarkers(live.vehicles, line, now, station === null ? null : activeTripId)
        : []
    ),
    [line, live, now, station, activeTripId],
  );

  // Guarded on a loaded line: a failed load must not put a half-known line
  // into the recents list.
  const recordedCode = line?.lineCode;
  useEffect(() => {
    if (line === undefined || recordedCode === undefined) return;
    recordLine({
      kind: 'line',
      lineCode: line.lineCode,
      shortName: line.shortName,
      longName: line.longName,
      agencyId: line.agencyId,
      type: line.type,
    });
    // `recordLine` is rebuilt every render by the recents provider, and `line`
    // is a fresh object on every query settle; the visit is keyed on the code
    // alone so it is recorded once per line, not once per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordedCode]);

  // From a station the spine is the rider's run itself: a variant can call at
  // stops the direction's representative row does not, and the rider's stop
  // must be on the list to be marked.
  const stops = useMemo(
    (): Place[] => (
      station !== null && trip
        ? trip.stops.map(({ stop }) => ({
          type: 'stop',
          lat: stop.lat,
          lon: stop.lon,
          stopId: stop.stopId,
          name: stop.name ?? undefined,
        }))
        : selected?.stops ?? []
    ),
    [station, trip, selected],
  );
  const boardingIndex = station === null
    ? -1
    : stops.findIndex((stop) => stop.stopId === station.stopId);
  const color = line ? routeColor({ agencyId: line.agencyId }) : theme.borderMuted;

  // The selected run's times, by stop, so the spine can ask for a stop's time
  // without walking the trip for each row. A stop the run does not call at --
  // and every stop when there is no run at all -- simply has none.
  const shownOffset = shownRun?.offsetSeconds ?? 0;
  const timeByStopId = useMemo(() => {
    const times = new Map<string, string | null>();
    for (const stop of trip?.stops ?? []) {
      const time = stop.departureTime ?? stop.arrivalTime;
      // An unscheduled run is its template trip, shifted by its start offset.
      times.set(stop.stop.stopId, time === null ? null : shiftIso(time, shownOffset));
    }
    return times;
  }, [trip, shownOffset]);

  function stopTime(stop: Place): string | null {
    if (stop.stopId === undefined) return null;
    return timeByStopId.get(stop.stopId) ?? null;
  }

  // The trip endpoint can answer the selected run's stop times against an
  // earlier service date than the run's own departure (GTFS trips repeat
  // across days, and the endpoint resolves whichever calendar instance it
  // finds first) -- left as given, a run that has not even started reads as
  // one that finished hours ago. Aligning onto the run's own departure (see
  // `alignStopTimesToRun`) fixes that for the fold only; the rows below still
  // show the trip's own clock times via `stopTime`. The anchor is the rider's
  // stop in station mode -- `runsAround` times runs at that stop -- or
  // otherwise the trip's own first stop, so the anchor's `timeByStopId` entry
  // and the run's `departureTime` describe the same call. Left unaligned when
  // the active trip is not one of these runs at all (a bus tapped straight
  // off the map): there is no run departure to align onto.
  const anchorStopId = station !== null ? station.stopId : (trip?.stops[0]?.stop.stopId ?? null);
  const tripAnchorTime = anchorStopId === null ? null : (timeByStopId.get(anchorStopId) ?? null);
  const alignedTimes = alignStopTimesToRun(
    stops.map((stop) => stopTime(stop)),
    tripAnchorTime,
    shownRun?.departureTime ?? null,
  );

  // Where the list starts: the later of the rider's stop and the stop the
  // selected bus has reached (see `firstRelevantStopIndex`). Its live position
  // is whichever of the polled buses runs the selected trip.
  // Vehicles answer per trip, and an unscheduled run's trip is only its
  // template: the dot on that trip is the timetable bus, not this one.
  const activeBus = shownRun?.unscheduled
    ? null
    : live?.vehicles.find((v) => v.tripId === activeTripId) ?? null;
  const firstIndex = firstRelevantStopIndex({
    stops: stops.map((stop, index) => ({ lat: stop.lat, lon: stop.lon, time: alignedTimes[index] ?? null })),
    boardingIndex,
    bus: activeBus === null ? null : { lat: activeBus.lat, lon: activeBus.lon },
    now,
  });
  // The fold belongs to one run: picking another run or direction folds the
  // stops again, derived from the key rather than reset by an effect.
  const foldKey = `${runsRouteId ?? ''}|${shownRun?.runId ?? activeTripId ?? ''}`;
  const [unfoldedKey, setUnfoldedKey] = useState<string | null>(null);
  const hiddenCount = unfoldedKey === foldKey ? 0 : firstIndex;
  const visibleStops = hiddenCount === 0 ? stops : stops.slice(hiddenCount);

  const edgePadding = useMapSheetEdgePadding();
  const boardingStop = boardingIndex >= 0 ? stops[boardingIndex] : undefined;
  const pins = useMemo<MapPin[]>(
    () => (boardingStop === undefined ? [] : [{
      key: `boarding:${boardingStop.stopId ?? ''}`,
      latitude: boardingStop.lat,
      longitude: boardingStop.lon,
      title: boardingStop.name,
    }]),
    [boardingStop],
  );

  const header = line === undefined ? null : (
    <View>
      <LineHeader line={line} direction={selected} />

      {line.directions.length > 1 && selected !== null && (
        <View style={styles.section}>
          <SegmentedControl
            options={line.directions.map((d) => ({
              value: d.direction,
              label: truncate(directionName(d) || (line.longName ?? ''), DIRECTION_LABEL_MAX),
            }))}
            value={selected.direction}
            onChange={setDirection}
          />
        </View>
      )}

      {runs !== undefined && runs.runs.length === 0 && (
        <View style={styles.section}>
          <ThemedText type="smallBold">{t('line.noRuns')}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
            {t('line.noRunsHint')}
          </ThemedText>
        </View>
      )}

      {runs !== undefined && runs.runs.length > 0 && (
        <View style={styles.section}>
          <ThemedText type="smallBold" style={styles.sectionTitle}>
            {t('line.runs')}
          </ThemedText>
          {/* Gesture-handler's ScrollView, not React Native's: inside the
              drawer, Android only lets a sideways swipe reach the strip when
              both gestures go through the same handler system. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.runStrip}
          >
            {runs.runs.map((run) => {
              const active = run.runId === shownRun?.runId;
              return (
                <Pressable
                  // By run, not trip: an unscheduled bus shares its template
                  // trip's id. Still paired with the time: the API can list
                  // one run twice.
                  key={`${run.runId}:${run.departureTime}`}
                  onPress={() => {
                    if (runsRouteId === null) return;
                    setPickedRun({ routeId: runsRouteId, run });
                  }}
                >
                  <View
                    style={[
                      styles.runChip,
                      { backgroundColor: active ? theme.text : theme.background },
                      active ? null : outline,
                    ]}
                  >
                    <ThemedText
                      type="smallBold"
                      themeColor={active ? 'background' : 'textSecondary'}
                    >
                      {formatClockTime(run.departureTime)}
                    </ThemedText>
                    {run.unscheduled && (
                      <ThemedText type="small" themeColor={active ? 'background' : 'textSecondary'}>
                        {t('line.unscheduled')}
                      </ThemedText>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {hiddenCount > 0 && (
        <PreviousStopsRow count={hiddenCount} color={color} onPress={() => setUnfoldedKey(foldKey)} />
      )}
    </View>
  );

  return (
    <MapScreen
      map={(
        shapePath.length > 1 ? (
          <LineMap
            coordinates={shapePath}
            color={color}
            dashed={shape?.geometryFallback ?? false}
            vehicles={vehicles}
            pins={pins}
            edgePadding={edgePadding}
            onVehiclePress={(tripId) => {
              // From a station the dots are this page's own runs, so a tap
              // selects one; otherwise it opens that bus's run.
              // A dot is always a timetable bus, whose `runId` is its `tripId`
              // -- the only unlisted dot `runNeighbours` draws is the board's
              // own trip, which is already the default.
              if (station !== null && runsRouteId !== null) {
                const tapped = runs?.runs.find((r) => r.runId === tripId);
                setPickedRun(tapped === undefined ? null : { routeId: runsRouteId, run: tapped });
              } else {
                router.push({ pathname: '/run/[tripId]', params: { tripId } });
              }
            }}
          />
        ) : (
          <View style={styles.mapPlaceholder} />
        )
      )}
    >
      <BottomSheetFlatList
        data={line ? visibleStops : []}
        keyExtractor={(item, index) => `${index + hiddenCount}:${item.stopId ?? item.name ?? ''}`}
        ListHeaderComponent={header}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.status}><ActivityIndicator /></View>
          ) : !line || isError ? (
            <View style={styles.status}><ThemedText type="default">{t('line.error')}</ThemedText></View>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        renderItem={({ item, index: visibleIndex }) => {
          const index = visibleIndex + hiddenCount;
          const stopId = item.stopId;
          return (
            <StopSpineRow
              stop={{ key: `${index}:${stopId ?? ''}`, name: item.name ?? stopId ?? '', time: stopTime(item) }}
              color={color}
              boarding={index === boardingIndex}
              passed={boardingIndex > 0 && index < boardingIndex}
              first={index === 0}
              last={index === stops.length - 1}
              onPress={
                stopId === undefined
                  ? undefined
                  : () => router.push({ pathname: '/station/[stopId]', params: { stopId, name: item.name ?? '' } })
              }
            />
          );
        }}
      />
    </MapScreen>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: Spacing.five,
  },
  lineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  lineHeaderText: {
    flex: 1,
    gap: Spacing.half,
  },
  // Cluster spacing, not `SectionGap`: see the station sheet's header for
  // why a sheet over a map cannot afford a page's rhythm.
  section: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
  },
  sectionTitle: {
    paddingBottom: Spacing.three,
  },
  hint: {
    paddingTop: Spacing.half,
  },
  runStrip: {
    gap: Spacing.two,
    paddingEnd: Spacing.four,
    alignItems: 'center',
  },
  runChip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
    alignItems: 'center',
  },
  // While the shape loads, `LineMap` has nothing to draw and returns `null`;
  // this keeps the page a full-screen view rather than a bare drawer.
  mapPlaceholder: {
    flex: 1,
  },
  status: {
    alignItems: 'center',
    paddingVertical: Spacing.five,
  },
});
