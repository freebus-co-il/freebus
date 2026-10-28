import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { ListRow, ListSection, Sheet, Text } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { formatClockTime } from '@/lib/format';
import { hapticSelected } from '@/lib/haptics';

import type { StationRun } from './station-board';

/**
 * "Which one are you on?", answered from the station's own board: the runs
 * the rider could have got on, most recent first. The journey names one from
 * GPS when they leave the station (see `boardedRun`); this is how they correct
 * it, including onto a line with a different stop near home.
 */
export function RunPickerSheet({
  runs, currentTripId, onChoose, onClose,
}: {
  /** The runs to offer; null closes the sheet. */
  runs: readonly StationRun[] | null;
  currentTripId: string | null;
  onChoose: (run: StationRun) => void;
  onClose: () => void;
}) {
  // Held through the closing animation, as `LineSwitchSheet` does with its leg.
  const [remembered, setRemembered] = useState<readonly StationRun[] | null>(runs);
  if (runs !== null && runs !== remembered) setRemembered(runs);
  const { t } = useTranslation();

  return (
    <Sheet visible={runs !== null} onClose={onClose} title={t('journey.switchLine.title')} closeLabel={t('common.close')}>
      {remembered && (
        <ScrollView style={styles.list}>
          <ListSection variant="plain">
            {remembered.map((run) => {
              const mine = run.tripId === currentTripId;
              const lineName = run.route.shortName?.trim()
                || (run.tripNumber ? t('results.trainNumber', { number: run.tripNumber }) : t(`results.modeType.${run.route.type}`, { defaultValue: '' }));
              const time = formatClockTime(run.departs);
              const headsign = formatHeadsign(run.headsign);
              return (
                <ListRow
                  key={run.key}
                  accessibilityLabel={[t('trip.lineOption', { line: lineName, time }), mine ? t('journey.switchLine.current') : null].filter(Boolean).join(', ')}
                  leading={<LineBadge route={run.route} />}
                  title={headsign === '' ? lineName : t('results.towards', { name: headsign })}
                  titleLines={1}
                  subtitle={run.alight.name ? t('journey.sheet.offAt', { name: run.alight.name }) : mine ? t('journey.switchLine.current') : undefined}
                  trailing={<Text variant="body" emphasized={mine} numeric>{time}</Text>}
                  accessory="check"
                  selected={mine}
                  onPress={() => {
                    if (!mine) hapticSelected();
                    onChoose(run);
                    onClose();
                  }}
                />
              );
            })}
          </ListSection>
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 0,
  },
});
