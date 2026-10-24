import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { STATION_BOARD_LIMIT, useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useNearbyStops } from '@/api/stops';
import { useVehicles } from '@/api/vehicles';
import type { NearbyStop } from '@/api/types';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { Card, Glass, Loading, Radius, Space, Text } from '@/design-system';
import { DepartureEntry } from '@/features/nearby/departure-entry';
import type { EdgePadding } from '@/features/results/trip-map';
import { useSearch } from '@/features/search/search-context';
import { stationTripIds, stationVehicleMarkers } from '@/features/stations/station-vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { formatDistanceMeters } from '@/lib/format';

import { NearbyMap } from './nearby-map';

/** The commute card's own height, so the two read as the same card. */
const CARD_HEIGHT = 280;
/** See `SmartSuggestion`: concentric corners. */
const PANEL_INSET = Radius.xl - Radius.lg;
/** Departures per station in the panel: one line, never clipped. */
const PANEL_DEPARTURES = 3;

/**
 * The home screen's hero card (see `HOME_CARD`), and the commute card's
 * stand-in when it has no commute to suggest. Same hero card, same
 * glass panel; the map shows where they are and the stations around them,
 * and the panel answers "what can I catch from here" with the closest
 * station and its next departures.
 *
 * Renders nothing until there is a fix and at least one station: the section
 * below already says why when the location fails.
 */
export function NearbySuggestion() {
  const { i18n } = useTranslation();
  const { originState } = useSearch();
  const here = originState.status === 'success' && originState.place.kind === 'coordinate'
    ? originState.place
    : null;
  const coords = here && { lat: here.lat, lon: here.lon };
  // Same query as `NearbyStops` below, so the two share one request.
  const { data, isLoading } = useNearbyStops(coords, i18n.language);
  const stops = useMemo(() => data?.stops ?? [], [data]);

  if (originState.status === 'error') return null;

  if (here === null || isLoading) {
    return (
      <Card variant="hero" padded={false} style={[styles.hero, styles.centered]}>
        <Loading />
      </Card>
    );
  }

  if (stops.length === 0) return null;

  return <ClosestStationCard here={here} stops={stops} closest={stops[0]} lang={i18n.language} />;
}

/**
 * The card itself: a peek at the closest station's own screen. The map draws
 * that station's live buses the way the station map does, the panel its next
 * departures, and a tap anywhere opens the station.
 */
function ClosestStationCard({ here, stops, closest, lang }: {
  here: { lat: number; lon: number };
  stops: readonly NearbyStop[];
  closest: NearbyStop;
  lang: string;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const showLive = useRealtimeAvailable();

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
  // rider's dot and the pins frame in the part of the card left visible.
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
    <Card
      variant="hero"
      padded={false}
      onPress={() => router.push({ pathname: '/station/[stopId]', params: { stopId: closest.stopId, name: closest.name ?? '' } })}
      accessibilityLabel={[t('nearby.title'), name, distance].join(', ')}
      style={styles.hero}
    >
      <NearbyMap here={here} stops={stops} vehicles={vehicles} edgePadding={edgePadding} style={styles.map} />

      {/* Not interactive -- the whole card is the tap target. */}
      <Glass
        variant="regular"
        shape="rounded"
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
    </Card>
  );
}

const styles = StyleSheet.create({
  hero: {
    height: CARD_HEIGHT,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  map: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // A backdrop, not a map to work with -- see `SmartSuggestion`.
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
