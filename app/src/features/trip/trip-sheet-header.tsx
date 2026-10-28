import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { Button, Space, Text } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { minutesUntil } from '@/features/results/itinerary-facts';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';

/** Past this, a countdown is arithmetic rather than an answer. Matches
 *  `ItineraryCard`, so the number does not change character on navigation. */
const LEAVE_COUNTDOWN_MAX_MINUTES = 60;

/**
 * The trip preview's answer and its action, side by side: when to leave --
 * with a verb, so it cannot be read as the bus's time -- and Start right next
 * to it, the way a map app puts Go beside the route it starts.
 */
export function TripSheetHeader({ itinerary, now, onStart, note }: {
  itinerary: Itinerary; now: Date; onStart: () => void; note?: string | null;
}) {
  const { t } = useTranslation();
  const { timeFormat } = usePreferences();
  const minutes = minutesUntil(itinerary.departureTime, now);
  const leave =
    minutes < 0
      ? t('results.leaveDeparted')
      : minutes < 1
        ? t('trip.leaveNow')
        : minutes <= LEAVE_COUNTDOWN_MAX_MINUTES && timeFormat === 'countdown'
          ? t('trip.leaveIn', { count: minutes })
          : t('trip.leaveAt', { time: formatClockTime(itinerary.departureTime) });
  const facts = [
    t('results.arriveAt', { time: formatClockTime(itinerary.arrivalTime) }),
    formatDurationMinutes(itinerary.durationSeconds),
    itinerary.transfers === 0 ? t('trip.direct') : t('trip.transfers', { count: itinerary.transfers }),
  ].join(' · ');

  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text variant="title1" emphasized color={minutes < 0 ? 'textSecondary' : 'textPrimary'} numberOfLines={1} adjustsFontSizeToFit>
          {leave}
        </Text>
        <Text variant="subheadline" color="textSecondary" numeric numberOfLines={1}>
          {facts}
        </Text>
        {note ? <Text variant="footnote" color="textSecondary" numeric>{note}</Text> : null}
      </View>
      <Button label={t('trip.start')} onPress={onStart} variant="prominent" size="lg" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  text: {
    flex: 1,
    gap: Space.xxs,
  },
});
