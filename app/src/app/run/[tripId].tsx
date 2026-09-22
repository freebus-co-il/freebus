import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useRouteRuns, useRouteShape } from '@/api/lines';
import { useTrip } from '@/api/trips';
import type { TripDetail } from '@/api/types';
import { useVehicles } from '@/api/vehicles';
import { LineBadge } from '@/components/line-badge';
import { MapScreen } from '@/components/map-screen';
import { useMapSheetEdgePadding } from '@/components/map-sheet';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { alignStopTimesToRun, firstRelevantStopIndex } from '@/features/lines/first-relevant-stop';
import { LineMap, type MapPin } from '@/features/lines/line-map';
import { PreviousStopsRow } from '@/features/lines/previous-stops-row';
import { runNeighbours } from '@/features/lines/run-neighbours';
import { StopSpineRow } from '@/features/lines/stop-spine';
import { formatHeadsign, tripNumberOf } from '@/features/results/itinerary-facts';
import { lineVehicleMarkers } from '@/features/results/vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { routeColor } from '@/lib/route-color';

function LineHeader({ trip }: { trip: TripDetail }) {
  const { t } = useTranslation();
  const last = trip.stops[trip.stops.length - 1];
  // The headsign is the sign on the front of the vehicle, which is what a
  // rider matches against; the final stop is the fact underneath it. They
  // usually agree, and when they don't the headsign is the one that helps.
  const towards = trip.headsign?.trim()
    ? formatHeadsign(trip.headsign)
    : (last?.stop.name ?? '');
  // A train's number leads the small line under "towards X", beside the stop
  // count: a fact about this run, kept out of the title a rider matches on.
  const trainNumber = tripNumberOf(trip);
  const details = [
    trainNumber === null ? null : t('results.trainNumber', { number: trainNumber }),
    t('run.stopCount', { count: trip.stops.length }),
  ].filter((part): part is string => part !== null).join(' · ');

  return (
    <View style={styles.lineHeader}>
      <LineBadge route={trip.route} />
      <View style={styles.lineHeaderText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {towards === '' ? (trip.route.longName ?? '') : t('results.towards', { name: towards })}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {details}
        </ThemedText>
      </View>
    </View>
  );
}

/**
 * One vehicle run: a full-screen map of its path with its bus and the runs
 * just before and after it on the road, and the page content -- header and
 * stop spine -- in the drawer over it.
 *
 * Reached by tapping a bus on a line page, and as a fallback from a station
 * board (`fromStopId`). A board of countdowns answers "when", and a rider
 * standing at a stop they do not know has a second question the board cannot
 * answer at all -- where this thing goes, and which of these names is the one
 * to get off at.
 *
 * The path and neighbours are anchored at the run's first stop, which every
 * run of the route calls at, so "the run before" means the bus that left the
 * start before this one. Tapping a neighbour's dot on the map replaces the
 * page's own run in place (`fromStopId` stays), rather than pushing a new
 * page, so the back stack still leads to wherever the rider came from.
 *
 * The stop list opens at `firstRelevantStopIndex` -- the later of the
 * boarding stop and wherever the bus has reached -- with everything before it
 * folded behind a "N previous stops" row the rider can unfold in place.
 */
export default function RunScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { tripId, fromStopId } = useLocalSearchParams<{ tripId?: string; fromStopId?: string }>();
  const now = useNow();

  // Tapping a neighbour swaps `tripId` in place, and the new trip takes a
  // moment to load. Kept on the previous trip meanwhile: a neighbour runs the
  // same route, so its path and shape are the same, and the map stays mounted
  // -- pan and zoom intact -- instead of blanking to a placeholder and the
  // drawer to a spinner.
  const { data: trip, isLoading, isError } = useTrip(tripId ?? null, i18n.language, { keepPreviousData: true });
  const stops = useMemo(() => trip?.stops ?? [], [trip]);
  const boardingIndex = useMemo(
    () => stops.findIndex((s) => s.stop.stopId === fromStopId),
    [stops, fromStopId],
  );
  const color = trip ? routeColor(trip.route) : theme.borderMuted;

  // The run's path, and the runs either side of it -- anchored at the run's
  // first stop, which every run of the route calls at, so "the run before"
  // means the bus that left the start before this one.
  const routeId = trip?.route.routeId ?? null;
  const { data: shape } = useRouteShape(routeId, trip?.directionId ?? 0);
  const shapePath = useMemo(
    () => (shape?.geometry.coordinates ?? []).map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
    [shape],
  );
  const firstStopId = stops[0]?.stop.stopId ?? null;
  const { data: runs } = useRouteRuns(
    routeId,
    i18n.language,
    firstStopId !== null && tripId ? { stopId: firstStopId, tripId } : null,
  );
  const neighbourTripIds = useMemo(
    () => runNeighbours(runs?.runs ?? [], tripId ?? null),
    [runs, tripId],
  );
  const { data: live } = useVehicles(neighbourTripIds);
  const vehicles = useMemo(
    () => (trip && live ? lineVehicleMarkers(live.vehicles, trip.route, now, trip.tripId) : []),
    [trip, live, now],
  );

  const activeBus = live?.vehicles.find((v) => v.tripId === tripId) ?? null;
  // The trip endpoint can answer this run's stop times against an earlier
  // service date than the run itself departs on (GTFS trips repeat across
  // days, and the endpoint resolves whichever calendar instance it finds
  // first) -- left as given, a run that has not even started reads as one
  // that finished hours ago, and `firstRelevantStopIndex` folds away every
  // stop of it. Aligning onto the run's own departure (see
  // `alignStopTimesToRun`) fixes that for the fold only; the rows below still
  // show the trip's own clock times. Left unaligned when this trip is not one
  // of `runs` at all -- there is no run departure to align onto.
  const selectedRun = runs?.runs.find((run) => run.tripId === tripId) ?? null;
  const tripAnchorTime = stops[0]?.departureTime ?? stops[0]?.arrivalTime ?? null;
  const alignedTimes = alignStopTimesToRun(
    stops.map((s) => s.departureTime ?? s.arrivalTime),
    tripAnchorTime,
    selectedRun?.departureTime ?? null,
  );
  const firstIndex = firstRelevantStopIndex({
    stops: stops.map((s, index) => ({ lat: s.stop.lat, lon: s.stop.lon, time: alignedTimes[index] ?? null })),
    boardingIndex,
    bus: activeBus === null ? null : { lat: activeBus.lat, lon: activeBus.lon },
    now,
  });
  const [unfoldedTripId, setUnfoldedTripId] = useState<string | null>(null);
  const hiddenCount = unfoldedTripId === tripId ? 0 : firstIndex;
  const visibleStops = hiddenCount === 0 ? stops : stops.slice(hiddenCount);

  const edgePadding = useMapSheetEdgePadding();
  const boardingStop = boardingIndex >= 0 ? stops[boardingIndex]?.stop : undefined;
  const pins = useMemo<MapPin[]>(
    () => (boardingStop === undefined ? [] : [{
      key: `boarding:${boardingStop.stopId}`,
      latitude: boardingStop.lat,
      longitude: boardingStop.lon,
      title: boardingStop.name ?? undefined,
    }]),
    [boardingStop],
  );

  return (
    <MapScreen
      map={shapePath.length > 1 ? (
        <LineMap
          coordinates={shapePath}
          color={color}
          dashed={shape?.geometryFallback ?? false}
          vehicles={vehicles}
          pins={pins}
          edgePadding={edgePadding}
          onVehiclePress={(pressed) => {
            // A neighbour becomes the page's run; the rider's stop stays.
            if (pressed !== tripId) router.setParams({ tripId: pressed });
          }}
        />
      ) : <View style={styles.mapPlaceholder} />}
    >
      <BottomSheetFlatList
        data={trip ? visibleStops : []}
        keyExtractor={(item) => `${item.stopSequence}:${item.stop.stopId}`}
        ListHeaderComponent={trip ? (
          <View>
            <LineHeader trip={trip} />
            {hiddenCount > 0 && (
              <PreviousStopsRow count={hiddenCount} color={color} onPress={() => setUnfoldedTripId(tripId ?? null)} />
            )}
          </View>
        ) : null}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.status}><ActivityIndicator /></View>
          ) : isError || !trip ? (
            <View style={styles.status}><ThemedText type="default">{t('run.error')}</ThemedText></View>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        renderItem={({ item, index: visibleIndex }) => {
          const index = visibleIndex + hiddenCount;
          return (
            <StopSpineRow
              stop={{
                key: `${item.stopSequence}:${item.stop.stopId}`,
                name: item.stop.name ?? item.stop.stopId,
                time: item.departureTime ?? item.arrivalTime,
              }}
              color={color}
              boarding={index === boardingIndex}
              passed={boardingIndex > 0 && index < boardingIndex}
              first={index === 0}
              last={index === stops.length - 1}
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
