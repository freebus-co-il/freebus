import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
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
 * instead, which offers every run, earlier ones included.
 *
 * Nothing at all when there is no other bus.
 */
export function LineOptionChips({ leg }: { leg: TransitLeg }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const options = laterOptions(leg);
  const current = currentOption(leg, options);
  const others = options.filter((option) => option.tripId !== leg.tripId);
  if (others.length === 0) return null;

  const noteFor = (verdict: LineVerdict): { text: string; color: 'danger' | 'success' } | null => {
    switch (verdict.kind) {
      case 'slower':
        return { text: t('trip.lineLater', { minutes: verdict.minutesLater }), color: 'danger' };
      case 'sooner':
        return { text: t('trip.lineSooner', { minutes: verdict.minutesSooner }), color: 'success' };
      case 'misses':
        return { text: t('trip.lineMisses'), color: 'danger' };
      case 'same':
        return null;
    }
  };

  return (
    <View style={[styles.block, { borderTopColor: theme.borderMuted }]}>
      <ThemedText type="small" themeColor="textSecondary">
        {t('trip.laterLines')}
      </ThemedText>
      <View style={styles.chips}>
        {others.map((option) => {
          const time = formatClockTime(option.from.departureTime);
          const line = option.route.shortName?.trim() || t(`results.modeType.${option.route.type}`, { defaultValue: '' });
          const note = noteFor(lineVerdict(option, current));
          const label = [t('trip.lineOption', { line, time }), note?.text].filter(Boolean).join(', ');
          return (
            <View key={option.tripId} accessible accessibilityLabel={label} style={[styles.chip, { backgroundColor: theme.background }, outline]}>
              <LineBadge route={option.route} size="small" />
              <ThemedText type="small" themeColor="textSecondary">
                {time}
              </ThemedText>
              {note && (
                <ThemedText type="smallBold" themeColor={note.color}>
                  {note.text}
                </ThemedText>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Under a hairline at the foot of the card: a fallback, read after the
  // ride itself, not a competitor for the top of it.
  block: {
    gap: Spacing.one,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
  // The same pill as the results card's departure chips.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingStart: Spacing.one,
    paddingEnd: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: 999,
  },
});
