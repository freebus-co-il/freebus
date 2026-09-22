import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { MARKER_RING_COLOR, MARKER_SNAPSHOT_MS, VehicleMarkerPins } from '@/features/results/vehicle-marker-pin';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';
import { useMapAppearance } from '@/hooks/use-map-appearance';
import { useLocationGranted } from '@/hooks/use-location-granted';
import { useTheme } from '@/hooks/use-theme';

/** What `react-native-maps` wants: latitude first, and named. GeoJSON's
 *  `[lon, lat]` pairs are converted by the caller (see `line/[lineCode]`),
 *  which is where the shape response is actually held. */
export type LatLng = { latitude: number; longitude: number };

/** A plain stop pin: the station a page is about, or the rider's own stop. */
export type MapPin = { key: string; latitude: number; longitude: number; title?: string };

export type LineMapProps = {
  /** The whole path, in travel order, already decoded.
   *
   *  Hold this MEMOIZED across renders: the camera fit is keyed on the array's
   *  identity, so a list rebuilt every render re-animates the fit every render
   *  -- the same trap `TripMap` documents at its own `fitCoordinates`. */
  coordinates: LatLng[];
  /** The line's colour, from `routeColor` -- the same value the stop spine
   *  under this map draws, so the two read as one object. */
  color: string;
  /** Drawn dashed, the way `TripMap` draws a leg whose geometry the planner
   *  had to fall back to straight lines for: a shape the feed never published
   *  should not claim to be the road the vehicle takes. */
  dashed?: boolean;
  /** The line's buses on the road, from `lineVehicleMarkers`. Never part of
   *  the camera's fit: the shape frames the map, and a bus reporting a bad
   *  position must not re-frame it. */
  vehicles?: readonly VehicleMarker[];
  /** Tapping a bus opens its run. */
  onVehiclePress?: (tripId: string) => void;
  /** Stops to pin on the path -- the rider's own stop, when the page knows
   *  one. Not part of the camera's fit. */
  pins?: readonly MapPin[];
  /** How much of the map the caller covers -- a drawer at the bottom -- so the
   *  path frames in the part that is still visible. Hold it MEMOIZED: the fit
   *  re-runs when its identity changes. */
  edgePadding?: EdgePadding;
  style?: StyleProp<ViewStyle>;
};

/** A stable "no buses", so the default prop is not a fresh array each render. */
const NO_VEHICLES: readonly VehicleMarker[] = [];
/** A stable "no pins", so the default prop is not a fresh array each render. */
const NO_PINS: readonly MapPin[] = [];

/** Plain breathing room -- nothing floats over this map, so the route only has
 *  to stay off the rounded corners of the box it sits in. A module constant so
 *  its identity never changes and the fit is not re-issued for it. */
const EDGE_PADDING = { top: 24, right: 24, bottom: 24, left: 24 };

/**
 * A line's shape, drawn on a full interactive map -- pan, zoom and rotate all
 * work, since it does not sit inside a scrolling list whose gestures would
 * need to be disabled.
 *
 * Deliberately NOT `TripMap`: that one takes an `Itinerary` and reads each
 * leg's `geometry` as an ENCODED polyline string, while a line has no
 * itinerary at all -- no times, no transfers, no boarding stop -- just a path.
 * Handing it one would mean fabricating a trip and an encoder to match. So
 * this is the small half of `TripMap`: a basemap and one stroke.
 *
 * Buses are, when the caller passes them -- the same dot, age label and fade
 * the journey map draws (`VehicleMarkerPins`), and tappable into their run.
 *
 * Stops are not marked here, except `pins`: the full stop list is the page
 * content directly below this map, named and timed and tappable; dotting
 * every one of them onto the shape as well would say the same thing twice,
 * and worse the second time.
 */
export function LineMap({
  coordinates, color, dashed = false, vehicles = NO_VEHICLES, onVehiclePress,
  pins = NO_PINS, edgePadding = EDGE_PADDING, style,
}: LineMapProps) {
  const { t } = useTranslation();
  const mapRef = useRef<MapView | null>(null);
  const { userInterfaceStyle, remountKey, customMapStyle } = useMapAppearance();
  const showsUserLocation = useLocationGranted();

  // Fewer than two points is not a path -- `fitToCoordinates` on a single one
  // zooms to its tightest level, which is a worse answer than the region below.
  const fitToShape = useCallback(
    (animated: boolean) => {
      if (coordinates.length < 2) return;
      mapRef.current?.fitToCoordinates(coordinates, { edgePadding, animated });
    },
    [coordinates, edgePadding],
  );

  // Re-fit when the shape changes -- the map stays mounted while the direction
  // toggle swaps one path for the other -- and again once the map is ready,
  // since a fit issued before native layout is a no-op on both platforms.
  useEffect(() => {
    fitToShape(true);
  }, [fitToShape]);

  // No path, no map: an empty basemap of some default neighbourhood answers
  // nothing the rider asked.
  const first = coordinates[0];
  if (first === undefined || coordinates.length < 2) return null;

  return (
    <MapView
      key={remountKey}
      ref={mapRef}
      style={[styles.map, style]}
      // The app's theme, not the phone's -- see `useMapAppearance`.
      userInterfaceStyle={userInterfaceStyle}
      // Required on Android, where an unstyled map draws a blank basemap.
      customMapStyle={customMapStyle}
      // The rider's own position, where they have already allowed it -- never
      // asked for from a map (see `useLocationGranted`). Native, not a child
      // marker, so it takes no part in the Android map's feature bookkeeping.
      showsUserLocation={showsUserLocation}
      // Google Maps' own recentre button would sit under the floating chips.
      showsMyLocationButton={false}
      onMapReady={() => fitToShape(false)}
      initialRegion={{
        latitude: first.latitude,
        longitude: first.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      }}
    >
      <Polyline
        coordinates={coordinates}
        strokeColor={color}
        strokeWidth={5}
        lineDashPattern={dashed ? [8, 6] : undefined}
      />
      {pins.map((pin) => (
        <StopPin key={pin.key} pin={pin} />
      ))}
      {/* Last: see `VehicleMarkerPins` for why nothing may follow it. */}
      <VehicleMarkerPins markers={vehicles} fallbackTitle={t('results.mapVehicle')} onPress={onVehiclePress} />
    </MapView>
  );
}

/** One stop pin: a white-ringed dot in the page's text colour, big enough to
 *  find on a full-screen map, smaller than any bus. Tracks view changes for
 *  one beat and then stops, exactly as `StopMarkerPin` in `trip-map.tsx`. */
function StopPin({ pin }: { pin: MapPin }) {
  const theme = useTheme();
  const [tracksViewChanges, setTracksViewChanges] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setTracksViewChanges(false), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Marker
      coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
      title={pin.title}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
    >
      <View style={[styles.stopPin, { backgroundColor: theme.text }]} />
    </Marker>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  stopPin: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: MARKER_RING_COLOR,
  },
});
