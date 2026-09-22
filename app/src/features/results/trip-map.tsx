import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, I18nManager, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import type { Itinerary, Leg, LiveVehicle, Place } from '@/api/types';
import { useMapAppearance } from '@/hooks/use-map-appearance';
import { useLocationGranted } from '@/hooks/use-location-granted';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { cameraKey, type NavigationCamera } from '@/features/journey/navigation/navigation-camera';
import { decodePolyline } from '@/lib/polyline';
import { routeColor, WALK_LEG_COLOR, withAlpha } from '@/lib/route-color';

import { legFocusCoordinates, withMinimumSpan } from './map-focus';
import { MARKER_RING_COLOR, MARKER_SNAPSHOT_MS, VehicleMarkerPins } from './vehicle-marker-pin';
import { ARROW_BOX, CARD_MARGIN, cardPanTarget, cardPlacement, type ScreenPoint } from './vehicle-card-placement';
import { vehicleMarkers, type LegPredictions } from './vehicle-markers';

/** How long a following camera takes to glide to the rider's next place. */
const NAVIGATION_CAMERA_MS = 800;

/** How long the camera takes to make room for a card, and the card to fade
 *  back in once the map settles. */
const CARD_NUDGE_MS = 300;
const CARD_FADE_MS = 150;

/** React Native mirrors `left`/`right` -- positions and borders alike -- under
 *  RTL unless an app opts out, while the map reports points physically. Read
 *  once: direction cannot change without a native restart. */
const SWAPS_LEFT_RIGHT = I18nManager.isRTL && I18nManager.getConstants().doLeftAndRightSwapInRTL;

export type EdgePadding = { top: number; right: number; bottom: number; left: number };

/** A whole line's path, drawn faded under the part of it the rider rides. */
export type LineShape = {
  key: string;
  color: string;
  coordinates: { latitude: number; longitude: number }[];
};

/** Faint enough that the rider's own leg, drawn over it at full strength, is
 *  unmistakably the part that is theirs. */
const LINE_SHAPE_OPACITY = 0.3;

/** The legs a focused map is NOT about. Stronger than a line's backdrop path,
 *  because these are still the rider's journey -- just not the part of it
 *  they are looking at. */
const UNFOCUSED_LEG_OPACITY = 0.4;
/** A line's backdrop while one leg is in focus. Fainter than usual: a faded
 *  leg drawn over its own line's backdrop stacks the two alphas, and would
 *  otherwise read nearly as strong as the leg in focus. */
const FOCUSED_LINE_SHAPE_OPACITY = 0.12;

/** A bare position for the map to pin. */
export type MapEndpoint = { lat: number; lon: number };

export type TripMapProps = {
  itinerary: Itinerary | null;
  /** The searched origin and destination. Used ONLY when there is no
   *  itinerary to draw: a search that returned nothing still owes the rider
   *  the two places they asked about, rather than a blank screen. Ignored
   *  while an itinerary is shown, whose own endpoints already carry the pins.
   *  Either may be null -- a stop saved before coordinates were carried
   *  through has none (see `placeCoordinates`). */
  origin?: MapEndpoint | null;
  destination?: MapEndpoint | null;
  style?: StyleProp<ViewStyle>;
  /** Drains the colour out of the BASEMAP -- and only the basemap -- so text
   *  can sit on top of it. Each platform has its own mechanism and neither
   *  reaches the other: iOS gets Apple's `mutedStandard` map type, which
   *  exists for exactly this (de-emphasised cartography under your own
   *  overlays); Android gets a Google `customMapStyle` desaturating every
   *  feature. Both leave the route line, its stop dots and the endpoint pins
   *  at full strength, which a blanket greyscale filter over the whole map
   *  would not -- and route colour carries meaning here. */
  monochrome?: boolean;
  /** Where the vehicles running this itinerary's legs are right now, straight
   *  from `GET /vehicles`. A vehicle naming a trip this itinerary does not
   *  ride is ignored, so a caller may pass the whole response without
   *  filtering it. Omitted or empty draws nothing at all -- which is the
   *  normal state, since the server withholds positions it cannot vouch for.
   *
   *  Deliberately excluded from the camera's fit (see `fitCoordinates`): a
   *  vehicle reporting a bad position must not re-frame the rider's map. */
  vehicles?: readonly LiveVehicle[];
  /** Tapping a vehicle hands its trip id here. Without it a tap opens the
   *  marker's plain title callout, as before. */
  onVehiclePress?: (tripId: string) => void;
  /** The full paths of the lines this itinerary rides, drawn faded beneath its
   *  legs so the rider can see where their bus comes from before their stop
   *  and where it goes after they get off. Like vehicles, never part of the
   *  camera's fit: a line crossing the country must not zoom the map out of
   *  the journey. Hold it memoized -- every new identity redraws the lines. */
  lineShapes?: readonly LineShape[];
  /** The vehicle whose `vehicleCard` is open, by trip id. */
  selectedVehicleTripId?: string | null;
  /** Drawn over the map directly above the selected vehicle, with an arrow at
   *  its dot, so the card reads as being about THAT bus. The map follows the
   *  card rather than the other way round: opening one nudges the camera just
   *  enough for it to fit, a pan or zoom hides it until the map settles, and
   *  each poll moves it with the bus. Built by the caller -- what a card says
   *  is the screen's business; where it sits is the map's. */
  vehicleCard?: ReactNode;
  /** A tap on the map itself -- not on any marker. */
  onMapPress?: () => void;
  /** How much of the map's own bounds to keep clear when framing the route --
   *  callers floating opaque chips over the map (a top bar, a bottom sheet)
   *  pass their actual measured heights here so the route never frames
   *  itself underneath them. Defaults to plain breathing room on all sides. */
  edgePadding?: EdgePadding;
  /** One leg of `itinerary` to be about: the camera frames just that leg, and
   *  every other leg and stop stays drawn but faded, so the rider keeps the
   *  shape of the whole journey while reading one part of it. Null or omitted
   *  frames and draws the whole journey. */
  focusLegIndex?: number | null;
  /** Where a running journey wants the camera -- following the rider, or
   *  framing what the current step is about (see `navigationCamera`). While set,
   *  it replaces framing the itinerary or the focused leg. */
  navigationCamera?: NavigationCamera | null;
  /** The rider is looking around: `navigationCamera` is held, not applied,
   *  until this goes back to false. */
  cameraPaused?: boolean;
  /** Live times for the itinerary's rides, by leg index, for each vehicle's
   *  countdown to the rider's stop. Hold it memoized. The timetable fills gaps. */
  vehiclePredictions?: LegPredictions;
  /** The rider is on this journey: a bus past their boarding stop counts down to
   *  the stop they get off at (see `vehicleMarkers`). */
  vehiclesTowardsAlighting?: boolean;
  /** The rider moved the map with a finger -- what pauses a following camera. */
  onUserGesture?: () => void;
  /** A walk leg re-planned from where the rider strayed, drawn in place of
   *  that leg's own line. */
  walkOverride?: { legIndex: number; geometry: string } | null;
};

type LatLng = { latitude: number; longitude: number };

/** One dot on the route line. `board`/`alight` are the stops the rider acts at
 *  (get on, get off, change) and are drawn larger; `intermediate` stops are the
 *  ones the vehicle merely passes through, so they're there to be counted and
 *  read, not to compete with the stops that need attention. */
type StopMarker = LatLng & {
  key: string;
  name: string | null;
  color: string;
  kind: 'board' | 'alight' | 'intermediate';
};

const DEFAULT_EDGE_PADDING: EdgePadding = { top: 50, right: 50, bottom: 50, left: 50 };

/** A stable identity for "no vehicles", so the default value of the `vehicles`
 *  prop is not a fresh array on every render -- which would invalidate the
 *  `useMemo` below on every render of every screen that never passes one. */
const EMPTY_VEHICLES: readonly LiveVehicle[] = [];
/** The same, for `lineShapes`. */
const EMPTY_LINE_SHAPES: readonly LineShape[] = [];

function legPlace(leg: Leg, end: 'from' | 'to'): Place {
  return leg.type === 'walk' ? leg[end] : leg[end].stop;
}

function toEndpoint(place: Place): MapEndpoint {
  return { lat: place.lat, lon: place.lon };
}

function legCoordinates(leg: Leg): LatLng[] {
  if (!leg.geometry) return [];
  return decodePolyline(leg.geometry).map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
}

/** Coordinates round-tripped through a fixed precision, so the same physical
 *  stop reached by two different legs (an alighting stop that is also the next
 *  leg's boarding stop) collapses to one dot instead of two stacked ones.
 *  ~1e-6 degrees is well under a metre, so distinct stops never collide. */
function coordinateKey(lat: number, lon: number): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/**
 * Every station the trip actually touches: each transit leg's boarding stop,
 * the stops it rides through, and its alighting stop -- in travel order.
 *
 * The trip's own start and end are skipped: they already carry the two full
 * pins, and a dot underneath one would just fight it. Walk legs contribute
 * nothing here; their endpoints are either those pins or a stop some transit
 * leg already claims.
 */
function itineraryStopMarkers(itinerary: Itinerary | null): StopMarker[] {
  if (!itinerary || itinerary.legs.length === 0) return [];

  const firstLeg = itinerary.legs[0]!;
  const lastLeg = itinerary.legs[itinerary.legs.length - 1]!;
  const start = legPlace(firstLeg, 'from');
  const end = legPlace(lastLeg, 'to');
  const seen = new Set([coordinateKey(start.lat, start.lon), coordinateKey(end.lat, end.lon)]);

  const markers: StopMarker[] = [];
  for (const leg of itinerary.legs) {
    if (leg.type !== 'transit') continue;
    const color = routeColor(leg.route);
    const stops: { place: Place; kind: StopMarker['kind'] }[] = [
      { place: leg.from.stop, kind: 'board' },
      ...leg.intermediateStops.map((place) => ({ place, kind: 'intermediate' as const })),
      { place: leg.to.stop, kind: 'alight' as const },
    ];
    for (const { place, kind } of stops) {
      const key = coordinateKey(place.lat, place.lon);
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({ key, latitude: place.lat, longitude: place.lon, name: place.name ?? null, color, kind });
    }
  }
  return markers;
}

/**
 * Every point the map has to keep in frame: each leg's decoded geometry plus
 * its endpoints, so legs without geometry (or with a straight-line fallback)
 * still can't push the trip off-screen. Stop markers join the set for the same
 * reason -- a straight-line leg's stops sit off its drawn line, and a dot the
 * fit didn't account for is a dot the rider has to pan to find.
 */
function itineraryCoordinates(itinerary: Itinerary | null, stopMarkers: StopMarker[]): LatLng[] {
  if (!itinerary) return [];
  return [
    ...itinerary.legs.flatMap((leg) => [
      { latitude: legPlace(leg, 'from').lat, longitude: legPlace(leg, 'from').lon },
      ...legCoordinates(leg),
      { latitude: legPlace(leg, 'to').lat, longitude: legPlace(leg, 'to').lon },
    ]),
    ...stopMarkers.map(({ latitude, longitude }) => ({ latitude, longitude })),
  ];
}

function legStrokeStyle(leg: Leg): { color: string; dashed: boolean } {
  if (leg.type === 'walk') {
    return { color: WALK_LEG_COLOR, dashed: leg.walkEstimated };
  }
  return {
    color: routeColor(leg.route),
    dashed: leg.geometryFallback,
  };
}

/**
 * One stop dot on the route line.
 *
 * Its own component purely because of `tracksViewChanges`: the native map
 * snapshots a custom marker view rather than re-rendering it live, and leaving
 * tracking on re-snapshots every dot on every frame -- with a trip's worth of
 * stops on screen, a visible pan/zoom stall. Tracking can't simply start off
 * either: a snapshot taken before the view has laid out leaves a blank marker.
 * So each dot tracks for one beat and then stops, and because these are keyed
 * by coordinate, switching trips remounts them and restarts that beat with no
 * effect having to reach back in and reset it.
 */
function StopMarkerPin({ marker, fallbackTitle, dimmed }: { marker: StopMarker; fallbackTitle: string; dimmed: boolean }) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setTracksViewChanges(false), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, []);

  const boardingOrAlighting = marker.kind !== 'intermediate';

  return (
    <Marker
      coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
      title={marker.name ?? fallbackTitle}
      // Centered on the coordinate: these dots mark a point ON the drawn line,
      // so the default bottom-tip anchor (right for a pin) would sit each one
      // a marker's height above the stop it is actually marking.
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      // The marker's own native opacity rather than a style on the view
      // inside it: that view is a snapshot, and fading it would mean
      // re-snapshotting every dot on every swipe.
      opacity={dimmed ? UNFOCUSED_LEG_OPACITY : 1}
    >
      <View
        style={[
          boardingOrAlighting ? styles.boardingDot : styles.intermediateDot,
          boardingOrAlighting ? { backgroundColor: marker.color } : { borderColor: marker.color },
        ]}
      />
    </Marker>
  );
}

export function TripMap({
  itinerary, origin = null, destination = null, style, monochrome = false,
  vehicles = EMPTY_VEHICLES, onVehiclePress, lineShapes = EMPTY_LINE_SHAPES,
  selectedVehicleTripId = null, vehicleCard = null, onMapPress,
  edgePadding = DEFAULT_EDGE_PADDING, focusLegIndex = null,
  navigationCamera = null, cameraPaused = false, onUserGesture, walkOverride = null,
  vehiclePredictions, vehiclesTowardsAlighting = false,
}: TripMapProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const mapRef = useRef<MapView | null>(null);
  const { userInterfaceStyle, remountKey, customMapStyle } = useMapAppearance({ monochrome });
  const showsUserLocation = useLocationGranted();

  const stopMarkers = useMemo(() => itineraryStopMarkers(itinerary), [itinerary]);
  // Ticks on its own, so a dot's age keeps counting between polls -- React
  // Query hands back the same array when a poll finds nothing new, which
  // would otherwise freeze the label on whatever it first said.
  const now = useNow();
  const liveVehicles = useMemo(
    () => vehicleMarkers(itinerary, vehicles, now, {
      predictions: vehiclePredictions, towardsAlighting: vehiclesTowardsAlighting,
    }),
    [itinerary, vehicles, now, vehiclePredictions, vehiclesTowardsAlighting],
  );

  const drawnItinerary = itinerary !== null && itinerary.legs.length > 0 ? itinerary : null;
  // The two pins, from the itinerary when there is one and from the search's
  // own endpoints when there is not.
  const startPlace: MapEndpoint | null = drawnItinerary
    ? toEndpoint(legPlace(drawnItinerary.legs[0]!, 'from'))
    : origin;
  const endPlace: MapEndpoint | null = drawnItinerary
    ? toEndpoint(legPlace(drawnItinerary.legs[drawnItinerary.legs.length - 1]!, 'to'))
    : destination;

  // What the camera has to frame -- held by COORDINATE, not by object
  // identity. `startPlace`/`endPlace` are rebuilt on every render (`toEndpoint`
  // allocates, and the props they fall back to are themselves built inline by
  // the caller), so a fit keyed on them re-ran on every render of the screen
  // above: swipe the trip carousel, let the 60-second re-plan land, let a card
  // change height, and the camera animated back to the route -- discarding
  // wherever the rider had just panned to. Keyed on the numbers, the fit
  // re-runs when the trip actually moves and at no other time, which is what
  // makes the map pannable at all.
  const startLat = startPlace?.lat ?? null;
  const startLon = startPlace?.lon ?? null;
  const endLat = endPlace?.lat ?? null;
  const endLon = endPlace?.lon ?? null;
  const focusedLeg = focusLegIndex === null ? undefined : drawnItinerary?.legs[focusLegIndex];
  const fitCoordinates = useMemo(() => {
    if (drawnItinerary && focusLegIndex !== null) {
      const focused = legFocusCoordinates(drawnItinerary, focusLegIndex);
      if (focused.length > 0) return withMinimumSpan(focused);
    }
    if (drawnItinerary) return itineraryCoordinates(drawnItinerary, stopMarkers);
    return [
      startLat !== null && startLon !== null ? { latitude: startLat, longitude: startLon } : null,
      endLat !== null && endLon !== null ? { latitude: endLat, longitude: endLon } : null,
    ].filter((point): point is LatLng => point !== null);
  }, [drawnItinerary, focusLegIndex, stopMarkers, startLat, startLon, endLat, endLon]);

  // The stops the focused leg touches, by the same key the dots are drawn
  // with. A dot shared with another leg -- a transfer stop -- stays lit
  // whichever of its two legs is in focus.
  const focusStopKeys = useMemo(() => {
    if (!focusedLeg) return null;
    const places = focusedLeg.type === 'walk'
      ? [focusedLeg.from, focusedLeg.to]
      : [focusedLeg.from.stop, ...focusedLeg.intermediateStops, focusedLeg.to.stop];
    return new Set(places.map((place) => coordinateKey(place.lat, place.lon)));
  }, [focusedLeg]);

  // `TripMap` stays mounted while the Results screen swaps itineraries, so
  // `initialRegion` alone would leave the camera parked wherever it started.
  // Re-fit whenever the itinerary changes (and once the map is ready, since a
  // fit issued before native layout is a no-op on both platforms).
  const fitToItinerary = useCallback(
    (animated: boolean) => {
      // Fewer than two points has no extent to frame -- `fitToCoordinates` on a
      // single one zooms to its tightest level, which is a worse answer than
      // leaving `initialRegion`'s neighbourhood view in place.
      if (fitCoordinates.length < 2) return;
      mapRef.current?.fitToCoordinates(fitCoordinates, {
        edgePadding,
        animated,
      });
    },
    [fitCoordinates, edgePadding],
  );

  const navigating = navigationCamera !== null;
  useEffect(() => {
    if (navigating) return;
    fitToItinerary(true);
  }, [fitToItinerary, navigating]);

  // --- The navigation camera ----------------------------------------------

  const [mapReady, setMapReady] = useState(false);
  // What the camera last moved to, by `cameraKey` -- so a new render with the
  // same place and heading moves nothing, and a real step or turn glides.
  const appliedCameraKey = useRef<string | null>(null);
  useEffect(() => {
    // Forgotten while paused or off, so resuming moves back even to the same place.
    if (navigationCamera === null || cameraPaused) {
      appliedCameraKey.current = null;
      return;
    }
    const map = mapRef.current;
    if (!mapReady || map === null) return;
    const key = cameraKey(navigationCamera);
    if (key === appliedCameraKey.current) return;
    appliedCameraKey.current = key;
    if (navigationCamera.kind === 'follow') {
      const { center, heading, pitch, zoom, altitude } = navigationCamera;
      map.animateCamera({ center, heading, pitch, zoom, altitude }, { duration: NAVIGATION_CAMERA_MS });
    } else if (navigationCamera.coordinates.length >= 2) {
      map.fitToCoordinates(navigationCamera.coordinates, { edgePadding, animated: true });
    }
  }, [navigationCamera, cameraPaused, mapReady, edgePadding]);

  // --- The selected vehicle's card ---------------------------------------

  const selectedVehicle = selectedVehicleTripId === null
    ? undefined
    : liveVehicles.find((marker) => marker.tripId === selectedVehicleTripId);
  const selectedLat = selectedVehicle?.latitude ?? null;
  const selectedLon = selectedVehicle?.longitude ?? null;

  const [mapSize, setMapSize] = useState<{ width: number; height: number } | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  // The bus's place on screen, stamped with the trip it was measured for, so
  // a card opened on another bus never borrows the previous bus's position.
  const [placed, setPlaced] = useState<{ tripId: string; point: ScreenPoint } | null>(null);
  const [cameraMoving, setCameraMoving] = useState(false);
  const [cardOpacity] = useState(() => new Animated.Value(0));
  // The selected bus's last reported coordinate. Kept past the bus dropping
  // out of the feed, so its card stays where it was last seen -- and a pan
  // after that can still re-measure where that is.
  const lastCoordinate = useRef<{ tripId: string; latitude: number; longitude: number } | null>(null);
  const placeRequest = useRef(0);
  const nudgedTripId = useRef<string | null>(null);

  const placeCard = useCallback(async (tripId: string) => {
    const coordinate = lastCoordinate.current;
    const map = mapRef.current;
    if (map === null || coordinate === null || coordinate.tripId !== tripId) return;
    const request = ++placeRequest.current;
    try {
      const point = await map.pointForCoordinate({ latitude: coordinate.latitude, longitude: coordinate.longitude });
      // A later measurement -- a newer poll, a later pan -- has already won.
      if (request === placeRequest.current) setPlaced({ tripId, point });
    } catch {
      // The map is not laid out yet; the next camera change or poll re-measures.
    }
  }, []);

  // Follow the bus: on opening, and on every poll that moves it.
  useEffect(() => {
    if (selectedVehicleTripId === null) {
      nudgedTripId.current = null;
      return;
    }
    if (selectedLat !== null && selectedLon !== null) {
      lastCoordinate.current = { tripId: selectedVehicleTripId, latitude: selectedLat, longitude: selectedLon };
    }
    void placeCard(selectedVehicleTripId);
  }, [selectedVehicleTripId, selectedLat, selectedLon, placeCard]);

  // Make room, once per opening -- and only once the card has a height to
  // make room for. Declared after the effect above, which records the
  // coordinate this reads.
  const insetTop = edgePadding.top;
  useEffect(() => {
    const tripId = selectedVehicleTripId;
    const map = mapRef.current;
    const coordinate = lastCoordinate.current;
    if (tripId === null || map === null || mapSize === null || cardHeight === 0) return;
    if (coordinate === null || coordinate.tripId !== tripId || nudgedTripId.current === tripId) return;
    nudgedTripId.current = tripId;
    void (async () => {
      try {
        const bus = await map.pointForCoordinate({ latitude: coordinate.latitude, longitude: coordinate.longitude });
        const target = cardPanTarget({ bus, map: mapSize, cardHeight, insetTop });
        if (target === null) return;
        const center = await map.coordinateForPoint(target);
        map.animateCamera({ center }, { duration: CARD_NUDGE_MS });
      } catch {
        // Only the nudge is lost: the card is still drawn above the bus.
      }
    })();
  }, [selectedVehicleTripId, selectedLat, mapSize, cardHeight, insetTop]);

  const busPoint = placed !== null && placed.tripId === selectedVehicleTripId ? placed.point : null;
  const placement = busPoint !== null && mapSize !== null ? cardPlacement({ bus: busPoint, map: mapSize }) : null;
  const cardVisible = vehicleCard !== null && placement !== null && !cameraMoving;

  // In on a short fade once the map has settled; out at once when it starts
  // moving, since a card left behind by a pan points at nothing.
  useEffect(() => {
    Animated.timing(cardOpacity, {
      toValue: cardVisible ? 1 : 0,
      duration: cardVisible ? CARD_FADE_MS : 0,
      useNativeDriver: true,
    }).start();
  }, [cardVisible, cardOpacity]);

  // Nothing to draw AND nowhere to point: the only case with no map at all.
  const center = startPlace ?? endPlace;
  if (center === null) return null;

  return (
    // A plain box around the map, so the card can float over it. The caller's
    // style sizes the box; the map fills it.
    <View
      style={[styles.map, style]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setMapSize({ width, height });
      }}
    >
    <MapView
      key={remountKey}
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      // A marker tap reaches the map's own handler too, tagged as one; only a
      // tap on the map itself is the rider dismissing what is open.
      onPress={(event) => {
        if (event.nativeEvent.action !== 'marker-press') onMapPress?.();
      }}
      onRegionChange={() => {
        if (selectedVehicleTripId !== null) setCameraMoving(true);
      }}
      onRegionChangeComplete={() => {
        if (selectedVehicleTripId === null) return;
        // Stays hidden until the new position is measured, so it never shows
        // for a frame where the bus used to be.
        void placeCard(selectedVehicleTripId).then(() => setCameraMoving(false));
      }}
      // The app's theme, not the phone's -- see `useMapAppearance`. Applied
      // under `monochrome` too: draining the colour out of a dark basemap
      // should leave it dark and grey, not light and grey.
      userInterfaceStyle={userInterfaceStyle}
      // Required on Android, where an unstyled map draws a blank basemap; it
      // also carries `monochrome` there. Ignored by Apple Maps, and `mapType`
      // below is ignored by Google Maps.
      customMapStyle={customMapStyle}
      // The rider's own position, where they have already allowed it -- never
      // asked for from a map (see `useLocationGranted`). Native, not a child
      // marker, so it takes no part in the Android map's feature bookkeeping.
      showsUserLocation={showsUserLocation}
      // Google Maps' own recentre button would sit under the floating chips.
      showsMyLocationButton={false}
      mapType={monochrome && Platform.OS === 'ios' ? 'mutedStandard' : 'standard'}
      onMapReady={() => {
        setMapReady(true);
        if (!navigating) fitToItinerary(false);
      }}
      // A finger on the map is the rider looking around; the caller pauses
      // following so the camera does not drag the map back from under them.
      onPanDrag={onUserGesture}
      initialRegion={{
        latitude: center.lat,
        longitude: center.lon,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      }}>
      {/* First, so every leg is drawn over its own line's faded path. */}
      {lineShapes.map((shape) => (
        <Polyline
          key={`line:${shape.key}`}
          coordinates={shape.coordinates}
          strokeColor={withAlpha(shape.color, focusedLeg ? FOCUSED_LINE_SHAPE_OPACITY : LINE_SHAPE_OPACITY)}
          strokeWidth={4}
        />
      ))}
      {(drawnItinerary?.legs ?? []).map((leg, index) => {
        const rerouted = walkOverride !== null && walkOverride.legIndex === index;
        const coordinates = rerouted
          ? decodePolyline(walkOverride.geometry).map(([lat, lon]) => ({ latitude: lat, longitude: lon }))
          : legCoordinates(leg);
        if (coordinates.length < 2) return null;
        const { color, dashed: plannedDashed } = legStrokeStyle(leg);
        // A re-route is a real street walk, whatever the planned one was.
        const dashed = rerouted ? false : plannedDashed;
        const dimmed = focusedLeg !== undefined && index !== focusLegIndex;
        return (
          <Polyline
            key={index}
            coordinates={coordinates}
            strokeColor={dimmed ? withAlpha(color, UNFOCUSED_LEG_OPACITY) : color}
            strokeWidth={(leg.type === 'walk' ? 3 : 5) - (dimmed ? 1 : 0)}
            lineDashPattern={dashed ? [8, 6] : undefined}
            // No `zIndex` here, deliberately. Under the new architecture a
            // top-level `zIndex` is read as the view's stacking order and
            // reorders the map's children when they mount, while the Android
            // map tracks its features by child position -- so a leg lifted
            // above the stop dots made removing an old trip's route remove the
            // wrong feature, and routes from other trips stayed on the map.
          />
        );
      })}
      {stopMarkers.map((marker) => (
        <StopMarkerPin
          key={marker.key}
          marker={marker}
          fallbackTitle={t('results.mapStop')}
          dimmed={focusStopKeys !== null && !focusStopKeys.has(marker.key)}
        />
      ))}
      {startPlace && (
        <Marker
          coordinate={{ latitude: startPlace.lat, longitude: startPlace.lon }}
          title={t('results.mapStart')}
        />
      )}
      {endPlace && (
        <Marker coordinate={{ latitude: endPlace.lat, longitude: endPlace.lon }} title={t('results.mapEnd')} />
      )}
      {/* Last, and nothing after it: the buses are the only children with a
          `zIndex`, and they must stay in z-index order at the end of the list
          or the Android map loses track of its features (see
          `VehicleMarkerPins`). */}
      <VehicleMarkerPins markers={liveVehicles} fallbackTitle={t('results.mapVehicle')} onPress={onVehiclePress} />
    </MapView>
      {vehicleCard !== null && selectedVehicleTripId !== null && (
        <Animated.View
          pointerEvents={cardVisible ? 'box-none' : 'none'}
          // Laid out by its foot, so it grows upward from the bus. Measured
          // even while hidden: the nudge needs its height before it shows.
          style={[styles.cardOverlay, { bottom: placement?.bottom ?? 0, opacity: cardOpacity }]}
          onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
        >
          {vehicleCard}
          {/* After the card, so it covers the card's hairline where it joins. */}
          <View
            style={[
              styles.cardArrow,
              SWAPS_LEFT_RIGHT ? { right: placement?.arrowLeft ?? 0 } : { left: placement?.arrowLeft ?? 0 },
              { backgroundColor: theme.background, borderColor: theme.borderMuted },
            ]}
          />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  cardOverlay: {
    position: 'absolute',
    left: CARD_MARGIN,
    right: CARD_MARGIN,
  },
  // A square turned 45° with two edges ruled, half of it tucked under the
  // card: a flat pointer with the card's own fill and hairline. The two ruled
  // edges are the ones RTL mirrors, so the turn mirrors with them.
  cardArrow: {
    position: 'absolute',
    bottom: -ARROW_BOX / 2,
    width: ARROW_BOX,
    height: ARROW_BOX,
    // Physical on purpose: the arrow points at a map POINT, which is physical,
    // and `SWAPS_LEFT_RIGHT` above already undoes React Native's mirroring.
    // eslint-disable-next-line no-restricted-syntax
    borderRightWidth: 1,
    borderBottomWidth: 1,
    transform: [{ rotate: SWAPS_LEFT_RIGHT ? '-45deg' : '45deg' }],
  },
  // Filled with the route's own color and ringed in white -- it has to stay
  // legible sitting directly on top of a stroke of that same color.
  boardingDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: MARKER_RING_COLOR,
  },
  // The inverse: white fill, route-colored ring. Reads as a bead threaded onto
  // the line rather than a stop the rider has to do something at.
  intermediateDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2.5,
    backgroundColor: MARKER_RING_COLOR,
  },
});
