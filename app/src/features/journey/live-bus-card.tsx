import { IconX } from '@tabler/icons-react-native';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTrip } from '@/api/trips';
import type { LiveVehicle, TransitLeg } from '@/api/types';
import { IconForward } from '@/components/directional-icon';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { agedness } from '@/features/results/vehicle-markers';
import { useTheme } from '@/hooks/use-theme';
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
  const theme = useTheme();
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
    <ThemedView type="background" style={[styles.card, { borderColor: theme.borderMuted }]}>
      <View style={styles.titleRow}>
        <LineBadge route={leg.route} size="small" />
        <ThemedText type="smallBold" numberOfLines={1} style={styles.title}>
          {headsign === '' ? '' : t('results.towards', { name: headsign })}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('journey.bus.close')}
          onPress={onClose}
          hitSlop={Spacing.three}
        >
          <IconX size={20} color={theme.textSecondary} />
        </Pressable>
      </View>

      <View>
        <ThemedText type="small" themeColor="textSecondary">{report}</ThemedText>
        {movedOn && (
          <ThemedText type="small" themeColor="textSecondary">{t('journey.bus.movedOn')}</ThemedText>
        )}
        {progress !== null && <ThemedText type="smallBold">{progressLine(progress, t)}</ThemedText>}
      </View>

      <Pressable accessibilityRole="button" onPress={onOpenRoute} style={styles.link} hitSlop={Spacing.two}>
        <ThemedText type="smallBold">{t('journey.bus.route')}</ThemedText>
        <IconForward size={16} color={theme.text} />
      </Pressable>
    </ThemedView>
  );
}

function progressLine(progress: LiveBusProgress, t: TFunction): string {
  if (progress.kind === 'toBoarding') {
    return progress.stops === 0 ? t('journey.bus.atBoarding') : t('journey.bus.toBoarding', { count: progress.stops });
  }
  return progress.stops === 0 ? t('journey.bus.atAlighting') : t('journey.bus.toAlighting', { count: progress.stops });
}

const styles = StyleSheet.create({
  // Flat like every card here: a background and a hairline, no shadow.
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.one,
  },
});
