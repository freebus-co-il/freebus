import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import type { StationKind } from '@/components/station-icon';
import { MARKER_SNAPSHOT_MS, VehicleMarkerPins } from '@/features/results/vehicle-marker-pin';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';
import { useMapAppearance } from '@/hooks/use-map-appearance';
import { useLocationGranted } from '@/hooks/use-location-granted';

export type StationMapProps = {
  center: { latitude: number; longitude: number } | null;
  title?: string;
  /** Which sign the station pin shows: a train station's, or a bus stop's. */
  kind?: StationKind;
  vehicles?: readonly VehicleMarker[];
  onVehiclePress?: (tripId: string) => void;
  /** Hold it MEMOIZED: the framing re-runs when its identity changes. */
  edgePadding?: EdgePadding;
  /** A line in focus: its path, drawn under the buses in its own colour.
   *  Dashed when the feed published no real shape for it. */
  route?: { coordinates: readonly { latitude: number; longitude: number }[]; color: string; dashed: boolean } | null;
  style?: StyleProp<ViewStyle>;
};

/** Half the side of the box framed around the station, in degrees of
 *  latitude: about 700 m either way -- the streets a rider walks, and the
 *  last few minutes of an incoming bus. */
const FRAME_HALF_LAT = 0.0065;
/** The station sign's size in points: `assets/images/station-pin*.png` are
 *  drawn at exactly this, @1x to @3x. */
const STATION_PIN_WIDTH = 24;
const STATION_PIN_HEIGHT = 32;

export type { StationKind };
/** Every sign shares one size and one pole, so either hangs from the same
 *  bottom-centre point. */
const STATION_PIN_SOURCES = {
  bus: require('@/assets/images/station-pin.png'),
  train: require('@/assets/images/train-station-pin.png'),
  lightRail: require('@/assets/images/light-rail-station-pin.png'),
  jerusalemLightRail: require('@/assets/images/jerusalem-light-rail-station-pin.png'),
  carmelit: require('@/assets/images/carmelit-station-pin.png'),
  metronit: require('@/assets/images/metronit-station-pin.png'),
} as const;
const NO_VEHICLES: readonly VehicleMarker[] = [];
const DEFAULT_EDGE_PADDING: EdgePadding = { top: 24, right: 24, bottom: 24, left: 24 };

/**
 * A map about one stop: the stop centred in the visible part of the map at
 * neighbourhood zoom, with the buses heading to it.
 *
 * Framed once per stop and never again as buses move: a bus that reports a
 * position across town must not drag the rider's map with it, and a map that
 * re-centres every poll cannot be panned.
 */
export function StationMap({
  center, title, kind = 'bus', vehicles = NO_VEHICLES, onVehiclePress, edgePadding = DEFAULT_EDGE_PADDING, style,
  route = null,
}: StationMapProps) {
  const { t } = useTranslation();
  const mapRef = useRef<MapView | null>(null);
  const { userInterfaceStyle, remountKey, customMapStyle } = useMapAppearance();
  const showsUserLocation = useLocationGranted();

  const lat = center?.latitude ?? null;
  const lon = center?.longitude ?? null;
  const frame = useCallback(
    (animated: boolean) => {
      if (lat === null || lon === null) return;
      const halfLon = FRAME_HALF_LAT / Math.cos((lat * Math.PI) / 180);
      mapRef.current?.fitToCoordinates(
        [
          { latitude: lat - FRAME_HALF_LAT, longitude: lon - halfLon },
          { latitude: lat + FRAME_HALF_LAT, longitude: lon + halfLon },
        ],
        { edgePadding, animated },
      );
    },
    [lat, lon, edgePadding],
  );

  useEffect(() => {
    frame(true);
  }, [frame]);

  // The snapshot beat starts once the pin image has loaded: a snapshot taken
  // before that is a blank marker that never repaints.
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  const [pinLoaded, setPinLoaded] = useState(false);
  useEffect(() => {
    if (!pinLoaded) return;
    const timer = setTimeout(() => setTracksViewChanges(false), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, [lat, lon, pinLoaded]);

  if (lat === null || lon === null) return <View style={[styles.map, style]} />;

  return (
    <MapView
      key={remountKey}
      ref={mapRef}
      style={[styles.map, style]}
      userInterfaceStyle={userInterfaceStyle}
      // Required on Android, where an unstyled map draws a blank basemap.
      customMapStyle={customMapStyle}
      // The rider's own position, where they have already allowed it -- never
      // asked for from a map (see `useLocationGranted`). Native, not a child
      // marker, so it takes no part in the Android map's feature bookkeeping.
      showsUserLocation={showsUserLocation}
      // Google Maps' own recentre button would sit under the floating chips.
      showsMyLocationButton={false}
      onMapReady={() => frame(false)}
      initialRegion={{ latitude: lat, longitude: lon, latitudeDelta: 0.02, longitudeDelta: 0.02 }}
    >
      {/* First, so the station and the buses sit on top of it. No `zIndex`:
          see `VehicleMarkerPins` for what that does to the Android map. */}
      {route !== null && route.coordinates.length >= 2 && (
        <Polyline
          coordinates={[...route.coordinates]}
          strokeColor={route.color}
          strokeWidth={5}
          lineDashPattern={route.dashed ? [8, 6] : undefined}
        />
      )}
      <Marker
        coordinate={{ latitude: lat, longitude: lon }}
        title={title}
        // A sign on a pole: the stop is where the pole meets the street, so
        // the pin hangs from its bottom-centre. `anchor` is Android (Google)
        // only; iOS draws with Apple Maps, which takes the same point as a
        // `centerOffset` in points instead.
        anchor={{ x: 0.5, y: 1 }}
        centerOffset={{ x: 0, y: -STATION_PIN_HEIGHT / 2 }}
        tracksViewChanges={tracksViewChanges}
      >
        <Image
          source={STATION_PIN_SOURCES[kind]}
          style={styles.stationPin}
          onLoad={() => setPinLoaded(true)}
        />
      </Marker>
      {/* Last: see `VehicleMarkerPins` for why nothing may follow it. */}
      <VehicleMarkerPins markers={vehicles} fallbackTitle={t('results.mapVehicle')} onPress={onVehiclePress} />
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  stationPin: {
    width: STATION_PIN_WIDTH,
    height: STATION_PIN_HEIGHT,
  },
});
