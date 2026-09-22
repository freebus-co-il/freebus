import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import type { MapStop } from '@/api/types';
import { stationKindOf } from '@/components/station-icon';
import { MARKER_SNAPSHOT_MS } from '@/features/results/vehicle-marker-pin';
import { useLocationGranted } from '@/hooks/use-location-granted';
import { useMapAppearance } from '@/hooks/use-map-appearance';

import type { MapRegion } from './map-tiles';

export type PickMapProps = {
  initialCenter: { lat: number; lon: number };
  stations: readonly MapStop[];
  /** Once per move, as the camera starts to travel. */
  onMoveStart: () => void;
  /** Where the camera came to rest -- after a drag, a pinch, or a tap on a
   *  station animating it to the centre. */
  onMoveEnd: (region: MapRegion) => void;
  /** How far up the map's legal label moves, clear of whatever floats over
   *  the map's bottom edge. */
  legalLabelBottomInset?: number;
  /** Where on the map view its camera's centre is drawn, in points. NOT the
   *  view's middle on iOS: Apple Maps centres the camera within the safe
   *  area, and a full-screen map's top inset is taller than its bottom one. */
  onCenterPoint?: (point: { x: number; y: number }) => void;
  style?: StyleProp<ViewStyle>;
};

/** Opening zoom: a few streets either way, close enough that the stations
 *  are already drawn (see `MAX_STATIONS_LAT_DELTA`). */
export const INITIAL_DELTA = 0.008;
const CENTER_ON_STATION_MS = 350;

/** The station map's own signs, at the size they are drawn: they hang from
 *  their bottom-centre, where the stop meets the street. */
const STATION_PIN_SOURCES = {
  bus: require('@/assets/images/station-pin.png'),
  train: require('@/assets/images/train-station-pin.png'),
  lightRail: require('@/assets/images/light-rail-station-pin.png'),
  jerusalemLightRail: require('@/assets/images/jerusalem-light-rail-station-pin.png'),
  carmelit: require('@/assets/images/carmelit-station-pin.png'),
  metronit: require('@/assets/images/metronit-station-pin.png'),
} as const;
const STATION_PIN_WIDTH = 24;
const STATION_PIN_HEIGHT = 32;

/**
 * One station's sign. A child `Image`, as on the station map, not the
 * marker's `image` prop: on iOS's new architecture that prop drew nothing at
 * all. A child view is a snapshot, so each sign tracks changes only until its
 * own image has loaded and been captured -- per marker, so a tile arriving
 * never re-captures the signs already standing.
 */
const StationPin = memo(function StationPin({
  station,
  onPress,
}: {
  station: MapStop;
  onPress: (station: MapStop) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [captured, setCaptured] = useState(false);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => setCaptured(true), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  // A sign on a pole: the stop is where the pole meets the street, so the
  // sign hangs from its bottom-centre. `anchor` is Google's; Apple Maps takes
  // the same point as `centerOffset`. (A clear box twice the sign's height,
  // centred instead, does NOT work on iOS: the map centred the sign itself.)
  return (
    <Marker
      coordinate={{ latitude: station.lat, longitude: station.lon }}
      anchor={{ x: 0.5, y: 1 }}
      centerOffset={{ x: 0, y: -STATION_PIN_HEIGHT / 2 }}
      tracksViewChanges={!captured}
      onPress={() => onPress(station)}
    >
      <Image
        source={STATION_PIN_SOURCES[stationKindOf(station)]}
        style={styles.stationPin}
        onLoad={() => setLoaded(true)}
      />
    </Marker>
  );
});

/**
 * The map under the location pin: the stations in view, each a tap away from
 * sitting under the pin. The pin itself is not drawn here -- it is the
 * screen's, fixed over the map's centre, since it marks the camera rather
 * than a coordinate.
 */
export function PickMap({
  initialCenter, stations, onMoveStart, onMoveEnd, legalLabelBottomInset = 0, onCenterPoint, style,
}: PickMapProps) {
  const mapRef = useRef<MapView | null>(null);
  const movingRef = useRef(false);
  const { userInterfaceStyle, remountKey, customMapStyle } = useMapAppearance();
  const showsUserLocation = useLocationGranted();

  // Asked of the map rather than assumed: see `onCenterPoint`.
  const reportCenter = useCallback(() => {
    const map = mapRef.current;
    if (map === null || onCenterPoint === undefined) return;
    map.getCamera()
      .then((camera) => map.pointForCoordinate(camera.center))
      .then(onCenterPoint)
      .catch(() => {
        // The screen keeps the pin where it last was.
      });
  }, [onCenterPoint]);

  const centerOn = useCallback((station: MapStop) => {
    mapRef.current?.animateCamera(
      { center: { latitude: station.lat, longitude: station.lon } },
      { duration: CENTER_ON_STATION_MS },
    );
  }, []);

  return (
    <MapView
      key={remountKey}
      ref={mapRef}
      style={[styles.map, style]}
      userInterfaceStyle={userInterfaceStyle}
      // Required on Android, where an unstyled map draws a blank basemap.
      customMapStyle={customMapStyle}
      showsUserLocation={showsUserLocation}
      showsMyLocationButton={false}
      // Apple Maps only. Not `mapPadding`: on Google that moves the camera's
      // centre off the view's centre, where the screen draws the pin.
      legalLabelInsets={{ top: 0, left: 0, right: 0, bottom: legalLabelBottomInset }}
      // A tap on a station centres it here, animated; Google's own marker
      // press would also pan the map and open an empty info window.
      moveOnMarkerPress={false}
      toolbarEnabled={false}
      // North stays up: the rider is placing a point, not navigating.
      rotateEnabled={false}
      pitchEnabled={false}
      initialRegion={{
        latitude: initialCenter.lat,
        longitude: initialCenter.lon,
        latitudeDelta: INITIAL_DELTA,
        longitudeDelta: INITIAL_DELTA,
      }}
      onRegionChange={() => {
        if (movingRef.current) return;
        movingRef.current = true;
        onMoveStart();
      }}
      onMapReady={reportCenter}
      onRegionChangeComplete={(region) => {
        movingRef.current = false;
        onMoveEnd(region);
        reportCenter();
      }}
    >
      {/* No `zIndex`: see `VehicleMarkerPins` for what that does to the
          Android map's marker bookkeeping. */}
      {stations.map((station) => (
        <StationPin key={station.stopId} station={station} onPress={centerOn} />
      ))}
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
