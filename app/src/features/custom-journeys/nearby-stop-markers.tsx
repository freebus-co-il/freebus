import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, StyleSheet, View } from 'react-native';
import { Marker } from 'react-native-maps';

import { LineBadge } from '@/components/line-badge';
import { stationKindOf } from '@/components/station-icon';
import { Border, Icon, Radius, Space, Text, useColors } from '@/design-system';
import { useSnapshotTracking } from '@/features/results/vehicle-marker-pin';
import { STATION_PIN_HEIGHT, STATION_PIN_SOURCES, STATION_PIN_WIDTH } from '@/features/stations/station-map';

import type { NearbyOption } from './nearby-options';

/** The label's fixed height and its gap above the sign: fixed, so the pin's
 *  hanging point (its pole's foot) can be offset exactly on iOS. */
const LABEL_HEIGHT = 26;
const LABEL_GAP = Space.xs;

function minutesUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((Date.parse(iso) - nowMs) / 60_000));
}

/**
 * One stop around the station: the same sign on a pole every other map pins
 * a stop with, and above it, when the stop has a run that makes the step, its
 * best line and how soon it leaves. The strong suggestion's label is filled
 * in the accent colour with a star, so a rider stepping out of the station
 * sees where to go before reading anything.
 */
function NearbyStopMarker({ option, strong, selected, nowMs, onPress }: {
  option: NearbyOption;
  strong: boolean;
  selected: boolean;
  nowMs: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  // The snapshot is only worth taking once the sign's image has loaded: one
  // taken before is a blank marker that never repaints.
  const [loaded, setLoaded] = useState(false);
  const best = option.best;
  const minutes = best ? minutesUntil(best.departs, nowMs) : null;
  const highlighted = strong || selected;
  const look = `${loaded}:${highlighted}:${best?.key ?? ''}:${minutes}:${colors.accent}:${colors.surfaceFloating}`;
  const tracksViewChanges = useSnapshotTracking(look) || !loaded;
  const height = STATION_PIN_HEIGHT + (best ? LABEL_HEIGHT + LABEL_GAP : 0);
  const ink = highlighted ? 'onAccent' : 'textPrimary';

  return (
    <Marker
      coordinate={{ latitude: option.lat, longitude: option.lon }}
      // Hung from the pole's foot, like `StationMap`'s pin: `anchor` on
      // Android (Google), the same point as a `centerOffset` on iOS.
      anchor={{ x: 0.5, y: 1 }}
      centerOffset={{ x: 0, y: -height / 2 }}
      tracksViewChanges={tracksViewChanges}
      onPress={onPress}
      title={option.name ?? undefined}
    >
      <View style={styles.wrap}>
        {best && (
          <View
            style={[
              styles.label,
              {
                backgroundColor: highlighted ? colors.accent : colors.surfaceFloating,
                borderColor: highlighted ? colors.mapMarkerRing : colors.controlEdge,
              },
            ]}
          >
            {strong && <Icon name="star" size="xs" color="onAccent" />}
            <LineBadge route={{ ...best.route, shortName: best.route.shortName ?? '' }} size="small" />
            <Text variant="caption1" emphasized numeric color={ink} numberOfLines={1}>
              {t('customJourney.map.in', { count: minutes ?? 0 })}
            </Text>
          </View>
        )}
        <Image
          source={STATION_PIN_SOURCES[stationKindOf(option)]}
          style={styles.pin}
          onLoad={() => setLoaded(true)}
        />
      </View>
    </Marker>
  );
}

/**
 * The stops around the ride's station, other than the planned one (the route
 * already marks it), for a journey the rider built. Rendered as children of
 * the journey's map; no `zIndex` on any of them (see `trip-map.tsx`).
 */
export function NearbyStopMarkers({ options, strongStopId, selectedStopId, nowMs, onSelect }: {
  options: readonly NearbyOption[];
  strongStopId: string | null;
  selectedStopId: string | null;
  nowMs: number;
  onSelect: (stopId: string) => void;
}) {
  return (
    <>
      {options.filter((option) => !option.current).map((option) => (
        <NearbyStopMarker
          key={`nearby:${option.stopId}`}
          option={option}
          strong={option.stopId === strongStopId}
          selected={option.stopId === selectedStopId}
          nowMs={nowMs}
          onPress={() => onSelect(option.stopId)}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: LABEL_GAP,
  },
  label: {
    height: LABEL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.xs,
    borderRadius: Radius.full,
    borderWidth: Border.default,
  },
  pin: {
    width: STATION_PIN_WIDTH,
    height: STATION_PIN_HEIGHT,
  },
});
