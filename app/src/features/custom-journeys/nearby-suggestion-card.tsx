import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Button, Icon, Space, Text } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { formatClockTime } from '@/lib/format';

import type { NearbyOption } from './nearby-options';

/**
 * The stop the map lit up (or the one the rider tapped), in the sheet: which
 * line to take from it, how far it is, and what walking there wins. "Go
 * there" puts that run on the ride and points the journey at the stop.
 */
export function NearbySuggestionCard({ option, strong, gainSeconds, nowMs, busy, onGo, onDismiss }: {
  option: NearbyOption;
  strong: boolean;
  gainSeconds: number | null;
  nowMs: number;
  busy: boolean;
  onGo: (() => void) | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const best = option.best;
  const walkMinutes = Math.max(1, Math.round(option.walkSeconds / 60));
  const name = option.name ?? t('customJourney.suggestion.unnamedStop');
  const title = strong
    ? t('customJourney.suggestion.strongTitle', { name })
    : name;

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        {strong && <Icon name="star" size="md" color="accent" />}
        <Text variant="headline" style={styles.grow} numberOfLines={2}>{title}</Text>
      </View>
      {best ? (
        <View style={styles.row}>
          <LineBadge route={{ ...best.route, shortName: best.route.shortName ?? '' }} size="small" />
          <View style={styles.grow}>
            <Text variant="callout" emphasized numberOfLines={1}>
              {formatHeadsign(best.headsign)}
            </Text>
            <Text variant="footnote" color="textSecondary" numeric numberOfLines={2}>
              {[
                t('customJourney.suggestion.leavesIn', { count: Math.max(0, Math.round((Date.parse(best.departs) - nowMs) / 60_000)) }),
                t('customJourney.suggestion.walk', { count: walkMinutes }),
                t('journey.sheet.arriveAt', { time: formatClockTime(best.arrives) }),
              ].join(' · ')}
            </Text>
          </View>
        </View>
      ) : (
        <Text variant="subheadline" color="textSecondary">{t('customJourney.suggestion.nothing')}</Text>
      )}
      {strong && (
        <Text variant="footnote" emphasized color="accent">
          {gainSeconds !== null
            ? t('customJourney.suggestion.sooner', { count: Math.max(1, Math.round(gainSeconds / 60)) })
            : t('customJourney.suggestion.onlyOption')}
        </Text>
      )}
      <View style={styles.row}>
        {best && onGo && (
          <Button variant="prominent" size="md" icon="walk" label={t('customJourney.suggestion.go')} loading={busy} onPress={onGo} />
        )}
        <Button variant="plain" size="md" label={t(strong ? 'customJourney.suggestion.stay' : 'common.close')} onPress={onDismiss} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  grow: { flex: 1 },
});
