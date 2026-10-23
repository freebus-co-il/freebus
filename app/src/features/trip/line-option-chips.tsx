import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { Chip, Separator, Space, Text } from '@/design-system';
import { formatClockTime } from '@/lib/format';

import { currentOption, laterOptions, lineVerdict, type LineVerdict } from './line-options';

/**
 * The other buses this ride can be taken on, each with the time it leaves and
 * -- when it matters -- how much later or sooner it gets the rider to the end
 * of the journey, counting the next connection it leads to when it misses the
 * planned one. A bus
 * that is as good as the planned one says nothing, because nothing needs
 * saying. The ride's own bus is not repeated: the card above leads with it.
 *
 * Read-only, and always later runs than the planned one -- a preview must not
 * suggest a bus already gone. On a running journey the same question --
 * which bus is the rider actually on -- is asked through `LineSwitchSheet`
 * instead, which offers every run, earlier ones included. Hence `info` chips:
 * nothing here is a control.
 *
 * Nothing at all when there is no other bus.
 */
export function LineOptionChips({ leg }: { leg: TransitLeg }) {
  const { t } = useTranslation();
  const options = laterOptions(leg);
  const current = currentOption(leg, options);
  const others = options.filter((option) => option.tripId !== leg.tripId);
  if (others.length === 0) return null;

  const noteFor = (verdict: LineVerdict): { text: string; color: 'danger' | 'live' } | null => {
    switch (verdict.kind) {
      case 'slower':
        return { text: t('trip.lineLater', { minutes: verdict.minutesLater }), color: 'danger' };
      case 'sooner':
        return { text: t('trip.lineSooner', { minutes: verdict.minutesSooner }), color: 'live' };
      case 'misses':
        return { text: t('trip.lineMisses'), color: 'danger' };
      case 'same':
        return null;
    }
  };

  return (
    // Under a separator at the foot of the card: a fallback, read after the
    // ride itself, not a competitor for the top of it.
    <View style={styles.block}>
      <Separator />
      <Text variant="footnote" color="textSecondary">
        {t('trip.laterLines')}
      </Text>
      <View style={styles.chips}>
        {others.map((option) => {
          const time = formatClockTime(option.from.departureTime);
          const line = option.route.shortName?.trim() || t(`results.modeType.${option.route.type}`, { defaultValue: '' });
          const note = noteFor(lineVerdict(option, current));
          const label = [t('trip.lineOption', { line, time }), note?.text].filter(Boolean).join(', ');
          return (
            // The verdict sits beside the chip rather than in it: it carries
            // its own colour (later in danger, sooner in live), and a chip's
            // label has one ink.
            <View key={option.tripId} accessible accessibilityLabel={label} style={styles.option}>
              <Chip variant="info" label={time} leading={<LineBadge route={option.route} size="small" />} />
              {note && (
                <Text variant="footnote" emphasized numeric color={note.color}>
                  {note.text}
                </Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: Space.sm,
    paddingTop: Space.xs,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
