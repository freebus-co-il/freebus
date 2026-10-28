import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { STATION_BOARD_LIMIT, useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useVehicles } from '@/api/vehicles';
import type { NearbyStop } from '@/api/types';
import { MapSchemeScope } from '@/components/map-scheme-scope';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { Glass, Loading, Opacity, Radius, Space, Text } from '@/design-system';
import type { EdgePadding } from '@/features/results/trip-map';
import { NearbyMap } from '@/features/smart-suggestion/nearby-map';
import { stationTripIds, stationVehicleMarkers } from '@/features/stations/station-vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { formatDistanceMeters } from '@/lib/format';

import { DepartureEntry } from './departure-entry';

const MAP_HEIGHT = 280;
/** Concentric corners: the panel's radius plus this inset is the group's. */
const PANEL_INSET = Radius.xl - Radius.lg;
/** Departures in the panel: one line, never clipped. */
const PANEL_DEPARTURES = 3;

/**
 * The top of the home screen's Nearby stations group, standing in for its
 * first row: the closest station, drawn as a peek at its own screen. The map
 * shows where the rider is, the stations around them and that station's live
 * buses; the glass panel carries the section's title, then names it and its
 * next departures. It heads the group in place of a section header, so the
 * title is said once.
 *
 * A tap anywhere opens the closest station.
 */
type ClosestStationMapProps = {
  here: { lat: number; lon: number };
  /** Nearest first; the first one is the station this map is about. */
  stops: readonly NearbyStop[];
  lang: string;
};

/** A map card: the panel floating on the map paints in the map's scheme. */
export function ClosestStationMap(props: ClosestStationMapProps) {
  return (
    <MapSchemeScope>
      <ClosestStationMapCard {...props} />
    </MapSchemeScope>
  );
}

function ClosestStationMapCard({ here, stops, lang }: ClosestStationMapProps) {
  const { t } = useTranslation();
  const now = useNow();
  const showLive = useRealtimeAvailable();
  const closest = stops[0];

  // The station screen's own board, so the two share one cache entry and
  // the board is already there when the rider taps through.
  const { data } = useStopDepartures(closest.stopId, STATION_BOARD_LIMIT, lang);
  const departures = useMemo(() => data?.departures ?? [], [data]);
  const tripIds = useMemo(() => stationTripIds(departures), [departures]);
  const { data: live } = useVehicles(tripIds);
  const vehicles = useMemo(
    () => stationVehicleMarkers(departures, live?.vehicles ?? [], now),
    [departures, live, now],
  );

  // The panel's measured height becomes the map's bottom padding, so the
  // rider's dot and the pins frame in the part of the map left visible.
  // Rounded so a sub-point relayout does not re-fit the map.
  const [panelHeight, setPanelHeight] = useState(0);
  const edgePadding = useMemo<EdgePadding>(
    () => ({ top: Space.xxl, right: Space.xxl, bottom: panelHeight + Space.lg, left: Space.xxl }),
    [panelHeight],
  );

  const name = closest.name ?? closest.stopId;
  const distance = formatDistanceMeters(closest.distanceMeters);
  const next = departures.slice(0, PANEL_DEPARTURES);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[t('nearby.title'), name, distance].join(', ')}
      onPress={() => router.push({ pathname: '/station/[stopId]', params: { stopId: closest.stopId, name: closest.name ?? '' } })}
      style={({ pressed }) => [styles.map, pressed && { opacity: Opacity.pressed }]}
    >
      <NearbyMap here={here} stops={stops} vehicles={vehicles} edgePadding={edgePadding} style={styles.fill} />

      {/* Not interactive -- the whole map is the tap target. */}
      <Glass
        variant="regular"
        shape="rounded"
        pointerEvents="none"
        style={styles.panel}
        onLayout={(event) => setPanelHeight(Math.round(event.nativeEvent.layout.height))}
      >
        <Text variant="headline" numberOfLines={1}>
          {t('nearby.title')}
        </Text>

        <View style={styles.station}>
          <View style={styles.stationRow}>
            <StationIcon kind={stationKindOf(closest)} />
            <Text variant="subheadline" emphasized numberOfLines={1} style={styles.grow}>
              {name}
            </Text>
            <Text variant="footnote" numeric color="textSecondary">
              {distance}
            </Text>
          </View>
          {next.length > 0 && (
            <View style={styles.departures}>
              {next.map((departure) => (
                <DepartureEntry
                  key={`${departure.runId}:${departure.departureTime}`}
                  departure={departure}
                  showLive={showLive}
                  now={now}
                />
              ))}
            </View>
          )}
        </View>
      </Glass>
    </Pressable>
  );
}

/** Holds the map's place while the fix and the stops are on their way, so
 *  the rows under it do not jump when it arrives. */
export function ClosestStationMapPlaceholder() {
  return (
    <View style={[styles.map, styles.centered]}>
      <Loading />
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    height: MAP_HEIGHT,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // A backdrop, not a map to work with: the whole map is the tap target.
    pointerEvents: 'none',
  },
  panel: {
    position: 'absolute',
    start: PANEL_INSET,
    end: PANEL_INSET,
    bottom: PANEL_INSET,
    borderRadius: Radius.lg,
    padding: Space.md,
    gap: Space.sm,
  },
  grow: {
    flex: 1,
  },
  station: {
    gap: Space.xs,
  },
  stationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  departures: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    // Under the name, not under the sign.
    paddingStart: Space.xxl,
  },
});
