import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { Icon, ListRow, Separator, Size } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';

/**
 * The trip, step by step, as one vertical list rather than cards to swipe:
 * the whole plan reads at a glance, and a tap on a step zooms the map to it
 * (a second tap lets the whole trip back in).
 */
export function TripStepsList({ itinerary, focusLegIndex, onFocus }: {
  itinerary: Itinerary;
  focusLegIndex: number | null;
  onFocus: (legIndex: number | null) => void;
}) {
  const { t } = useTranslation();
  const toggle = (legIndex: number) => () => onFocus(focusLegIndex === legIndex ? null : legIndex);
  const lastIndex = itinerary.legs.length - 1;

  return (
    <View>
      {itinerary.legs.map((leg, legIndex) => {
        const row = leg.type === 'walk' ? (
          <ListRow
            dense
            leading={<View style={styles.lead}><Icon name="walk" size="md" color="textSecondary" /></View>}
            title={t('trip.walkFor', { duration: formatDurationMinutes(leg.durationSeconds) })}
            subtitle={legIndex === lastIndex
              ? t('trip.toDestination')
              : t('trip.toPlace', { name: leg.to.name?.trim() || t('trip.unnamedStop') })}
            onPress={toggle(legIndex)}
          />
        ) : (
          <ListRow
            dense
            leading={<View style={styles.lead}><LineBadge route={leg.route} /></View>}
            title={[
              leg.headsign.trim() ? t('results.towards', { name: formatHeadsign(leg.headsign) }) : null,
              t('trip.stops', { count: leg.numStops }),
            ].filter(Boolean).join(' · ')}
            subtitle={t('trip.fromAt', {
              name: leg.from.stop.name?.trim() || t('trip.unnamedStop'),
              time: formatClockTime(leg.realtime?.predictedDeparture ?? leg.from.departureTime),
            })}
            onPress={toggle(legIndex)}
          />
        );
        return (
          <View key={legIndex}>
            {legIndex > 0 && <Separator />}
            {row}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  lead: {
    minWidth: Size.leadingTile,
    alignItems: 'center',
  },
});
