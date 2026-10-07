import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { DataCredit } from '@/components/data-credit';
import type { StationKind } from '@/components/station-icon';
import { MARKER_RING_COLOR, MARKER_SNAPSHOT_MS, VehicleMarkerPins } from '@/features/results/vehicle-marker-pin';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';
import { useMapAppearance } from '@/hooks/use-map-appearance';
import { useLocationGranted } from '@/hooks/use-location-granted';

import { PARKED, stopDotSlots, type StopDot, type StopDotSlot } from './route-stops';

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
  route?: {
    coordinates: readonly { latitude: number; longitude: number }[];
    color: string;
    dashed: boolean;
    /** "osm" when the path is OpenStreetMap rail track -- see `routePath`. */
    credit?: 'osm' | null;
  } | null;
  /** The stops of the line in focus, dotted along its path. */
  stops?: readonly StopDot[];
  style?: StyleProp<ViewStyle>;
};

/** How many stop dots the map keeps mounted -- more than nearly any run has.
 *  See `stopDotSlots` for why the pool is fixed rather than one per stop. */
const STOP_DOT_POOL = 150;
/** The journey map's own fade for what the rider is not riding. */
const DIMMED_DOT_OPACITY = 0.4;
const NO_STOPS: readonly StopDot[] = [];

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
  route = null, stops = NO_STOPS,
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

  const hasPath = route !== null && route.coordinates.length >= 2;
  const slots = useMemo(() => stopDotSlots(stops, STOP_DOT_POOL), [stops]);
  const dotColor = route?.color ?? null;

  if (lat === null || lon === null) return <View style={[styles.map, style]} />;

  return (
    // A plain box around the map, so the credit can float over it.
    <View style={[styles.map, style]}>
    <MapView
      key={remountKey}
      ref={mapRef}
      style={styles.map}
      userInterfaceStyle={userInterfaceStyle}
      // Required on Android, where an unstyled map draws a blank basemap.
      customMapStyle={customMapStyle}
      // The rider's own position, where they have already allowed it -- never
      // asked for from a map (see `useLocationGranted`). Native, not a child
      // marker, so it takes no part in the Android map's feature bookkeeping.
      showsUserLocation={showsUserLocation}
      // Google Maps' own recentre button would sit under the floating chips.
      showsMyLocationButton={false}
      // Apple Maps only: keeps its logo and Legal link above the drawer, as
      // its terms require. Not `mapPadding` -- see pick-map.tsx.
      legalLabelInsets={{ top: 0, left: 0, right: 0, bottom: edgePadding.bottom }}
      onMapReady={() => frame(false)}
      initialRegion={{ latitude: lat, longitude: lon, latitudeDelta: 0.02, longitudeDelta: 0.02 }}
    >
      {/* First, so the station and the buses sit on top of it. No `zIndex`:
          see `VehicleMarkerPins` for what that does to the Android map.
          ALWAYS mounted, and simply invisible with no line in focus: drawn
          only when there was one, it was inserted at the front of the
          map's children every time a line was picked -- the very insert the
          Android map mishandled before react-native-maps 1.28.1, stranding
          the station's other markers as red pins. */}
      <Polyline
        coordinates={hasPath ? [...route.coordinates] : [{ latitude: lat, longitude: lon }, { latitude: lat, longitude: lon }]}
        strokeColor={hasPath ? route.color : 'transparent'}
        strokeWidth={hasPath ? 5 : 0}
        lineDashPattern={hasPath && route.dashed ? [8, 6] : undefined}
      />
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
      {/* A fixed pool, never one marker per stop -- see `stopDotSlots`. */}
      {slots.map((slot, index) => (
        // Keyed by index: a slot IS its position, which is the point of the pool.
        <StopDotMarker key={index} slot={slot} color={dotColor} />
      ))}
      {/* Last: see `VehicleMarkerPins` for why nothing may follow it. */}
      <VehicleMarkerPins markers={vehicles} fallbackTitle={t('results.mapVehicle')} onPress={onVehiclePress} />
    </MapView>
      {route?.credit && (
        <DataCredit source={route.credit} variant="overlay" style={[styles.credit, { bottom: edgePadding.bottom + 4 }]} />
      )}
    </View>
  );
}

/**
 * One slot of the stop-dot pool: a ring in the line's colour, as the journey
 * map draws a stop it passes. A parked slot is hidden by the marker's own
 * opacity, and dimming is the same native opacity, so only a new line
 * colour changes the view -- and re-arms the one-beat snapshot, as
 * `StopMarkerPin` in `trip-map.tsx` explains.
 */
function StopDotMarker({ slot, color }: { slot: StopDotSlot; color: string | null }) {
  // Derived, as `useSnapshotTracking` in `vehicle-marker-pin` does it: on
  // while the colour differs from the one last snapshotted, so a new line
  // turns tracking back on in the same render and only the timer settles it.
  const [snapshotted, setSnapshotted] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSnapshotted(color), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, [color]);
  const tracksViewChanges = snapshotted !== color;

  const visible = slot.visible && color !== null;
  const shown = visible ? slot : PARKED;

  return (
    <Marker
      coordinate={{ latitude: shown.latitude, longitude: shown.longitude }}
      title={visible ? shown.name : undefined}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      opacity={!visible ? 0 : shown.dimmed ? DIMMED_DOT_OPACITY : 1}
      // Google only: a parked slot must not take a tap.
      tappable={visible}
    >
      <View style={[styles.stopDot, { borderColor: color ?? MARKER_RING_COLOR }]} />
    </Marker>
  );
}

const styles = StyleSheet.create({
  // The journey map's intermediate stop, exactly -- see `trip-map.tsx`.
  stopDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2.5,
    backgroundColor: MARKER_RING_COLOR,
  },
  credit: {
    position: 'absolute',
    alignSelf: 'center',
  },
  map: {
    flex: 1,
  },
  stationPin: {
    width: STATION_PIN_WIDTH,
    height: STATION_PIN_HEIGHT,
  },
});
