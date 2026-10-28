import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useTrip } from '@/api/trips';
import type { LiveVehicle, TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { Card, Icon, IconButton, Opacity, Space, Text, useColors } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { agedness } from '@/features/results/vehicle-markers';
import { formatClockTime } from '@/lib/format';

import { legBusProgress, type LiveBusProgress } from './live-bus';

export type LiveBusCardProps = {
  leg: TransitLeg;
  /** The leg's bus from the latest poll; null while it is not reporting. */
  vehicle: LiveVehicle | null;
  now: Date;
  onClose: () => void;
  onOpenRoute: () => void;
};

/**
 * What a tap on a bus on the journey map tells the rider: which bus it is,
 * how old the dot's position is, and how far it is from their stop.
 *
 * The age is the point. The pill on the map is short by necessity, and a
 * rider deciding whether to run for a bus needs to know that the dot is where
 * the bus WAS -- stated as a clock time, with a plain warning once the report
 * is old enough that the bus has likely moved on (the same threshold that
 * dims the dot).
 */
export function LiveBusCard({ leg, vehicle, now, onClose, onOpenRoute }: LiveBusCardProps) {
  const { t, i18n } = useTranslation();
  const colors = useColors();
  const { data: trip } = useTrip(leg.tripId, i18n.language);

  const headsign = leg.headsign?.trim() ? formatHeadsign(leg.headsign) : leg.to.stop.name ?? '';
  const progress = trip ? legBusProgress(trip, leg, vehicle, now) : null;

  let report: string;
  let movedOn = false;
  if (vehicle === null) {
    report = t('journey.bus.noPosition');
  } else if (vehicle.recordedAt === null) {
    report = t('journey.bus.noReportTime');
  } else {
    const { ageMinutes, faded } = agedness(vehicle.recordedAt, now);
    const age = ageMinutes === null || ageMinutes === 0
      ? t('results.vehicleAgeNow')
      : t('results.vehicleAge', { count: ageMinutes });
    report = t('journey.bus.updated', { age, time: formatClockTime(vehicle.recordedAt) });
    movedOn = faded;
  }

  return (
    <Card variant="floating">
      <View style={styles.titleRow}>
        <LineBadge route={leg.route} size="small" />
        <Text variant="subheadline" emphasized numberOfLines={1} style={styles.title}>
          {headsign === '' ? '' : t('results.towards', { name: headsign })}
        </Text>
        <IconButton
          icon="close"
          variant="plain"
          size="sm"
          color="textSecondary"
          accessibilityLabel={t('journey.bus.close')}
          onPress={onClose}
        />
      </View>

      <View>
        <Text variant="subheadline" color="textSecondary" numeric>{report}</Text>
        {movedOn && (
          <Text variant="subheadline" color="textSecondary">{t('journey.bus.movedOn')}</Text>
        )}
        {progress !== null && <Text variant="subheadline" emphasized numeric>{progressLine(progress, t)}</Text>}
      </View>

      {/* A link, not a button: the card's facts are the point, and this is the
          way to more of them. Text plus a forward chevron, the platform's
          "goes somewhere" shape. */}
      <Pressable
        accessibilityRole="button"
        onPress={onOpenRoute}
        hitSlop={Space.sm}
        android_ripple={{ color: colors.fillPressed, borderless: true }}
        style={({ pressed }) => [styles.link, pressed && Platform.OS === 'ios' && { opacity: Opacity.pressed }]}
      >
        <Text variant="subheadline" emphasized color="accent">{t('journey.bus.route')}</Text>
        <Icon name="chevronForward" size="sm" color="accent" weight="semibold" />
      </Pressable>
    </Card>
  );
}

function progressLine(progress: LiveBusProgress, t: TFunction): string {
  if (progress.kind === 'toBoarding') {
    return progress.stops === 0 ? t('journey.bus.atBoarding') : t('journey.bus.toBoarding', { count: progress.stops });
  }
  return progress.stops === 0 ? t('journey.bus.atAlighting') : t('journey.bus.toAlighting', { count: progress.stops });
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  title: {
    flex: 1,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Space.xs,
  },
});
