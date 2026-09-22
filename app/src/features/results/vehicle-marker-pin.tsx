import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View } from 'react-native';
import { Marker } from 'react-native-maps';

import { ThemedText } from '@/components/themed-text';
import { VehicleIcon } from '@/components/vehicle-icon';
import { useTheme } from '@/hooks/use-theme';
import { readableTextColor } from '@/lib/route-color';

import type { VehicleMarker } from './vehicle-markers';

/** Every custom marker's white ring, so a marker stays legible sitting on a
 *  stroke of its own colour. */
export const MARKER_RING_COLOR = '#ffffff';
/** Native map markers rendered from a custom view are snapshotted by the map;
 *  see `useSnapshotTracking` below for why that snapshot needs one moment of
 *  tracking before it can be switched off. */
export const MARKER_SNAPSHOT_MS = 300;

/**
 * Stacking, which both platforms also use to decide which marker a tap hits.
 * Every arrival label sits below every vehicle: labels hang under their bus and
 * are wider than it, so where buses bunch up one bus's label lies over the next
 * bus -- and when the two were one marker, that label took the tap meant for
 * the bus. The rider's own run is on top. All of it is above every stop dot and
 * both endpoint pins: a vehicle is the one marker on a map telling the rider
 * something they don't already know.
 */
const LABEL_Z_INDEX = 9;
const SECONDARY_VEHICLE_Z_INDEX = 11;
const VEHICLE_Z_INDEX = 12;

/** The vehicle capsule's height; it grows sideways with the line number. */
const VEHICLE_HEIGHT = 28;
/** A neighbour of the rider's run: still unmistakably a bus, but smaller than
 *  the one they are waiting for. Size, not opacity -- dimming already means
 *  "this report is old". */
const SECONDARY_VEHICLE_HEIGHT = 20;
const LABEL_PILL_HEIGHT = 18;
const LABEL_PILL_GAP = 2;
/** A marker whose report is old enough that the bus has likely moved on.
 *  Dimmed, not hidden: it is still the best guess of where the bus is. */
const FADED_VEHICLE_OPACITY = 0.6;
/** How far a stale bus's colour is washed towards white. */
const FADED_COLOR_MIX = 0.45;

/**
 * `hex` washed towards white by `amount` -- an OPAQUE paler colour, because
 * opacity lets whatever sits underneath show through: where buses bunch, the
 * arrival label hanging under the bus in front would show straight through a
 * translucent one ("44" and "arriving" printed over each other). Anything
 * that is not `#rrggbb` comes back as it is.
 */
function washed(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const channel = (value: string) =>
    Math.round(parseInt(value, 16) + (255 - parseInt(value, 16)) * amount).toString(16).padStart(2, '0');
  return `#${channel(match[1]!)}${channel(match[2]!)}${channel(match[3]!)}`;
}

type VehicleMarkerProps = {
  marker: VehicleMarker;
  fallbackTitle: string;
  onPress?: (tripId: string) => void;
};

/**
 * A custom marker view is a SNAPSHOT: once tracking is switched off, the map
 * keeps drawing the old image. A bus's countdown, fade and size change while
 * its markers stay mounted, so each new look re-arms one snapshot rather than
 * leaving a marker that says "3 min" forever. Tracking is DERIVED -- on while
 * the look differs from the one last snapshotted -- so a change turns it back
 * on in the same render, and only the timer settles it.
 */
function useSnapshotTracking(look: string): boolean {
  const [snapshottedLook, setSnapshottedLook] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSnapshottedLook(look), MARKER_SNAPSHOT_MS);
    return () => clearTimeout(timer);
  }, [look]);
  return snapshottedLook !== look;
}

function heightOf(marker: VehicleMarker): number {
  return marker.secondary ? SECONDARY_VEHICLE_HEIGHT : VEHICLE_HEIGHT;
}

function fadeOf(marker: VehicleMarker) {
  return marker.faded && { opacity: FADED_VEHICLE_OPACITY };
}

/** When the bus reaches the rider's stop, in a pill under it -- or nothing,
 *  where there is no stop of theirs to count to. */
function VehicleArrivalLabel({ marker, onPress }: Omit<VehicleMarkerProps, 'fallbackTitle'>) {
  const { t } = useTranslation();
  const theme = useTheme();

  const label = marker.etaMinutes === null
    ? null
    : marker.etaMinutes === 0
      ? t('results.vehicleEtaNow')
      : t('results.vehicleEta', { minutes: marker.etaMinutes });
  const tracksViewChanges = useSnapshotTracking(`${label ?? ''}|${marker.faded}|${marker.secondary}`);
  if (label === null) return null;

  const vehicleHeight = heightOf(marker);
  const pill = (
    <View style={[styles.labelPill, { backgroundColor: theme.background, borderColor: theme.borderMuted }, fadeOf(marker)]}>
      <ThemedText type="smallBold" style={styles.labelText}>
        {label}
      </ThemedText>
    </View>
  );

  // The pill hangs half the vehicle's height and a gap below the bus, and each
  // map has to be told that its own way.
  //
  // Apple Maps centres a custom view on its coordinate, ignores `anchor` and
  // reads only `centerOffset`, so there the view is the bare pill pushed down
  // by the drop to its centre -- the placement verified on device.
  //
  // Google Maps ignores `centerOffset` and reads only `anchor`, a fraction of
  // the view that Google documents within [0, 1]. The bare pill would need an
  // anchor far above its own top edge (about -0.9), which nothing promises to
  // honour, so there the view is a transparent spacer the height of the vehicle
  // and gap with the pill under it, and the anchor -- the vehicle's centre --
  // lies inside the view. The spacer overlaps only vehicles, and every vehicle
  // is stacked above it.
  const labelDrop = vehicleHeight / 2 + LABEL_PILL_GAP + LABEL_PILL_HEIGHT / 2;
  const labelHeight = vehicleHeight + LABEL_PILL_GAP + LABEL_PILL_HEIGHT;
  const placement = Platform.select({
    ios: {
      anchor: { x: 0.5, y: 0.5 - labelDrop / LABEL_PILL_HEIGHT },
      centerOffset: { x: 0, y: labelDrop },
      view: pill,
    },
    default: {
      anchor: { x: 0.5, y: vehicleHeight / 2 / labelHeight },
      centerOffset: undefined,
      view: (
        <View style={[styles.label, { height: labelHeight, paddingTop: vehicleHeight + LABEL_PILL_GAP }]}>
          {pill}
        </View>
      ),
    },
  });

  return (
    <Marker
      coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
      onPress={onPress ? () => onPress(marker.tripId) : undefined}
      anchor={placement.anchor}
      centerOffset={placement.centerOffset}
      tracksViewChanges={tracksViewChanges}
      zIndex={LABEL_Z_INDEX}
    >
      {placement.view}
    </Marker>
  );
}

/**
 * The bus itself: a capsule in the line's colour, ringed in white, carrying the
 * line's number -- the one thing a rider reads off a bus coming down the street,
 * so the map says it the same way. A line with no number (rail, here) carries
 * its vehicle glyph instead.
 */
function VehicleCapsule({ marker, fallbackTitle, onPress }: VehicleMarkerProps) {
  const shortName = marker.shortName?.trim() ?? '';
  const tracksViewChanges = useSnapshotTracking(`${marker.faded}|${marker.secondary}|${shortName}|${marker.color}`);
  const height = heightOf(marker);
  const fill = marker.faded ? washed(marker.color, FADED_COLOR_MIX) : marker.color;
  const textColor = readableTextColor(fill);

  return (
    <Marker
      coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
      title={onPress ? undefined : (marker.shortName ?? fallbackTitle)}
      onPress={onPress ? () => onPress(marker.tripId) : undefined}
      // Centred on the reported position on both platforms: Apple Maps
      // centres a custom view by default, Google Maps reads this.
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      zIndex={marker.secondary ? SECONDARY_VEHICLE_Z_INDEX : VEHICLE_Z_INDEX}
    >
      <View
        style={[
          styles.capsule,
          {
            height,
            minWidth: height,
            borderRadius: height / 2,
            borderWidth: marker.secondary ? 2 : 3,
            paddingHorizontal: marker.secondary ? 3 : 5,
            backgroundColor: fill,
          },
        ]}
      >
        {shortName === '' ? (
          <VehicleIcon type={marker.routeType} size={marker.secondary ? 11 : 16} color={textColor} />
        ) : (
          <ThemedText
            type="smallBold"
            style={[marker.secondary ? styles.capsuleTextSecondary : styles.capsuleText, { color: textColor }]}
            numberOfLines={1}
          >
            {shortName}
          </ThemedText>
        )}
      </View>
    </Marker>
  );
}

/**
 * Every bus (or train) on a map, where it actually is -- on the journey map,
 * a line's map and a station's alike, so a bus looks the same wherever the
 * rider meets it.
 *
 * Each bus is TWO markers, the capsule and the arrival label under it. A
 * marker's tap target is its whole view, and a label cannot be made untappable
 * on Apple Maps (`tappable` is Google-only), so the only way to keep a label off
 * a neighbouring bus is to stack it below every bus -- see the z-indexes above.
 *
 * Rendered in z-index order -- every label, then every neighbouring bus, then
 * the rider's own -- and LAST among the map's children, never interleaved bus
 * by bus. Under the new architecture a `zIndex` prop reorders a view's
 * children when they mount, while the Android map tracks its features by child
 * position; children whose z-indexes are out of order get removed at the wrong
 * position, leaving markers from a map's previous contents behind -- stripped
 * of their custom view, as Google's default red pin. Already in order, the
 * reordering changes nothing.
 *
 * Keyed by `tripId` rather than by coordinate, so a moving vehicle UPDATES its
 * markers instead of unmounting and remounting them -- which is what lets the
 * native map slide the bus rather than blink it.
 *
 * With `onPress` the bus -- capsule or label -- is a way into its run, and
 * carries no `title`: a title makes the tap open a callout first, a bubble that
 * flashes up for the instant before the page it names replaces the map.
 */
export function VehicleMarkerPins(
  { markers, fallbackTitle, onPress }:
  { markers: readonly VehicleMarker[]; fallbackTitle: string; onPress?: (tripId: string) => void },
) {
  return (
    <>
      {markers.map((marker) => (
        <VehicleArrivalLabel key={`label:${marker.tripId}`} marker={marker} onPress={onPress} />
      ))}
      {markers.filter((marker) => marker.secondary).map((marker) => (
        <VehicleCapsule key={`dot:${marker.tripId}`} marker={marker} fallbackTitle={fallbackTitle} onPress={onPress} />
      ))}
      {markers.filter((marker) => !marker.secondary).map((marker) => (
        <VehicleCapsule key={`dot:${marker.tripId}`} marker={marker} fallbackTitle={fallbackTitle} onPress={onPress} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  // Google Maps only: the transparent box the pill hangs at the bottom of.
  label: {
    alignItems: 'center',
  },
  // Bigger than either stop dot, and the only marker carrying a line number, so
  // the vehicle is told apart from the stops it passes at a glance and at arm's
  // length. Size and ring width are set per marker: the rider's run, or a
  // neighbour.
  capsule: {
    borderColor: MARKER_RING_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsuleText: {
    fontSize: 13,
    lineHeight: 16,
  },
  capsuleTextSecondary: {
    fontSize: 10,
    lineHeight: 13,
  },
  // Flat, like every chip in this app: background and a hairline, no shadow.
  labelPill: {
    height: LABEL_PILL_HEIGHT,
    minWidth: VEHICLE_HEIGHT,
    paddingHorizontal: 6,
    borderRadius: LABEL_PILL_HEIGHT / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelText: {
    fontSize: 11,
    lineHeight: 14,
  },
});
