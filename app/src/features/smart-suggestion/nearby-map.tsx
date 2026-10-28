import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import type { NearbyStop } from '@/api/types';
import { stationKindOf } from '@/components/station-icon';
import type { EdgePadding } from '@/features/results/trip-map';
import { MARKER_SNAPSHOT_MS, VehicleMarkerPins } from '@/features/results/vehicle-marker-pin';
import type { VehicleMarker } from '@/features/results/vehicle-markers';
import { STATION_PIN_HEIGHT, STATION_PIN_SOURCES, STATION_PIN_WIDTH } from '@/features/stations/station-map';
import { useLocationGranted } from '@/hooks/use-location-granted';
import { useMapAppearance } from '@/hooks/use-map-appearance';

/** Half the side of the box framed around the closest station, in degrees of
 *  latitude: about 700 m either way -- `StationMap`'s own frame, so the card
 *  is a peek at that screen and the buses a few minutes out are in view. */
const FRAME_HALF_LAT = 0.0065;

export type NearbyMapProps = {
  here: { lat: number; lon: number };
  stops: readonly NearbyStop[];
  /** The live buses heading to the closest station, as its own screen draws
   *  them. Never part of the framing: a bus reporting a position across town
   *  must not zoom the card out of the rider's street. */
  vehicles: readonly VehicleMarker[];
  /** Hold it MEMOIZED: the framing re-runs when its identity changes. */
  edgePadding: EdgePadding;
  style?: StyleProp<ViewStyle>;
};

/**
 * The commute card's map, for a rider with no commute to suggest: where they
 * are and the stations around them, on the same drained basemap. A backdrop,
 * not a map to work with -- framed once per fix and closest station, never
 * panned -- with the closest station's live buses on it, as a peek at that
 * station's own map.
 */
export function NearbyMap({ here, stops, vehicles, edgePadding, style }: NearbyMapProps) {
  const { t } = useTranslation();
  const mapRef = useRef<MapView | null>(null);
  const { userInterfaceStyle, remountKey, customMapStyle } = useMapAppearance({ monochrome: true });
  const showsUserLocation = useLocationGranted();

  // Framed on the closest station (the list is nearest first), and on the
  // rider in case they stand outside that box.
  const center = stops[0] ?? here;
  const frame = useCallback(
    (animated: boolean) => {
      const halfLon = FRAME_HALF_LAT / Math.cos((center.lat * Math.PI) / 180);
      mapRef.current?.fitToCoordinates(
        [
          { latitude: center.lat - FRAME_HALF_LAT, longitude: center.lon - halfLon },
          { latitude: center.lat + FRAME_HALF_LAT, longitude: center.lon + halfLon },
          { latitude: here.lat, longitude: here.lon },
        ],
        { edgePadding, animated },
      );
    },
    [center.lat, center.lon, here.lat, here.lon, edgePadding],
  );

  useEffect(() => {
    frame(true);
  }, [frame]);

  return (
    <MapView
      key={remountKey}
      ref={mapRef}
      style={style}
      userInterfaceStyle={userInterfaceStyle}
      // Required on Android, where an unstyled map draws a blank basemap; it
      // also carries the monochrome look there.
      customMapStyle={customMapStyle}
      mapType={Platform.OS === 'ios' ? 'mutedStandard' : 'standard'}
      showsUserLocation={showsUserLocation}
      showsMyLocationButton={false}
      legalLabelInsets={{ top: 0, left: 0, right: 0, bottom: edgePadding.bottom }}
      onMapReady={() => frame(false)}
      initialRegion={{ latitude: here.lat, longitude: here.lon, latitudeDelta: 0.02, longitudeDelta: 0.02 }}
    >
      {stops.map((stop) => (
        <StopPin key={stop.stopId} stop={stop} />
      ))}
      {/* Last: see `VehicleMarkerPins` for why nothing may follow it. */}
      <VehicleMarkerPins markers={vehicles} fallbackTitle={t('results.mapVehicle')} />
    </MapView>
  );
}

/** One station's sign, hung from its pole like `StationMap`'s own pin. */
function StopPin({ stop }: { stop: NearbyStop }) {
  // The snapshot beat starts once the image has loaded: a snapshot taken
  // before that is a blank marker that never repaints.
  const [loaded, setLoaded] = useState(false);
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => setTracksViewChanges(false), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  return (
    <Marker
      coordinate={{ latitude: stop.lat, longitude: stop.lon }}
      anchor={{ x: 0.5, y: 1 }}
      centerOffset={{ x: 0, y: -STATION_PIN_HEIGHT / 2 }}
      tracksViewChanges={tracksViewChanges}
    >
      <Image source={STATION_PIN_SOURCES[stationKindOf(stop)]} style={styles.pin} onLoad={() => setLoaded(true)} />
    </Marker>
  );
}

const styles = StyleSheet.create({
  pin: {
    width: STATION_PIN_WIDTH,
    height: STATION_PIN_HEIGHT,
  },
});
