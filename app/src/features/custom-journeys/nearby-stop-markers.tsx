import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Marker } from 'react-native-maps';

import { Border, Icon, Radius, Space, Text, useColors } from '@/design-system';
import { useSnapshotTracking } from '@/features/results/vehicle-marker-pin';

import type { NearbyOption } from './nearby-options';

function minutesUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((Date.parse(iso) - nowMs) / 60_000));
}

/**
 * One stop around the station, as a pin the rider can tap: its best line and
 * how soon it leaves. The strong suggestion is the treasure on the map: filled
 * in the accent colour, with a star and the line to run for, so a rider
 * stepping out of the station sees where to go before reading anything.
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
  const best = option.best;
  const line = best ? (best.route.shortName?.trim() || null) : null;
  const minutes = best ? minutesUntil(best.departs, nowMs) : null;
  const label = best
    ? line
      ? t('customJourney.map.lineIn', { line, count: minutes ?? 0 })
      : t('customJourney.map.in', { count: minutes ?? 0 })
    : null;
  // Re-snapshotted whenever what the pin shows changes; still otherwise, so
  // a map of a few pins costs nothing between polls.
  const look = `${strong}:${selected}:${label}:${colors.accent}:${colors.mapMarkerRing}`;
  const tracksViewChanges = useSnapshotTracking(look);

  const highlighted = strong || selected;
  const fill = highlighted ? colors.accent : colors.surfaceFloating;
  const ink = highlighted ? 'onAccent' : best ? 'textPrimary' : 'textTertiary';

  return (
    <Marker
      coordinate={{ latitude: option.lat, longitude: option.lon }}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={tracksViewChanges}
      onPress={onPress}
      title={option.name ?? undefined}
    >
      <View style={styles.wrap}>
        <View
          style={[
            styles.pill,
            strong && styles.strongPill,
            { backgroundColor: fill, borderColor: highlighted ? colors.mapMarkerRing : colors.controlEdge },
          ]}
        >
          <Icon name={strong ? 'star' : 'bus'} size={strong ? 'sm' : 'xs'} color={ink} />
          {label !== null && (
            <Text variant={strong ? 'subheadline' : 'caption1'} emphasized numeric color={ink} numberOfLines={1}>
              {label}
            </Text>
          )}
        </View>
        <View style={[styles.stem, { backgroundColor: highlighted ? colors.accent : colors.controlEdge }]} />
        <View style={[styles.dot, { backgroundColor: highlighted ? colors.accent : colors.textTertiary, borderColor: colors.mapMarkerRing }]} />
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
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.sm,
    paddingVertical: Space.xxs,
    borderRadius: Radius.full,
    borderWidth: Border.default,
  },
  strongPill: {
    paddingHorizontal: Space.md,
    paddingVertical: Space.xs,
    borderWidth: Border.selected,
  },
  stem: {
    width: Border.selected,
    height: Space.sm,
  },
  dot: {
    width: Space.md,
    height: Space.md,
    borderRadius: Radius.full,
    borderWidth: Border.selected,
  },
});
