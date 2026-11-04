import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Border, Button, Icon, Radius, Space, Text, useColors, withAlpha } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { formatClockTime } from '@/lib/format';

import type { NearbyOption } from './nearby-options';

/** The tip's tint: the walk legs' amber, so the card reads as the same idea
 *  as the walk the map draws to the stop. */
const TIP_FILL = 0.14;
const TIP_EDGE = 0.5;
/** The leading walk tile. */
const TILE = 36;

/**
 * The stop the map lit up (or the one the rider tapped), in the sheet: which
 * line to take from it, how far it is, and what walking there wins. "Go
 * there" puts that run on the ride and points the journey at the stop.
 *
 * The one the app suggests on its own (`strong`) is a tip: a solid card
 * tinted with the walk amber, led by what it wins ("Arriving 4 min sooner"),
 * so it does not read as one more line of the sheet. A stop the rider tapped
 * is the same card, neutral, led by its name.
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
  const colors = useColors();
  const best = option.best;
  const walkMinutes = Math.max(1, Math.round(option.walkSeconds / 60));
  const name = option.name ?? t('customJourney.suggestion.unnamedStop');
  const walkTo = t('customJourney.suggestion.walkTo', {
    walk: t('customJourney.suggestion.walk', { count: walkMinutes }),
    name,
  });

  const title = !strong
    ? name
    : gainSeconds !== null
      ? t('customJourney.suggestion.sooner', { count: Math.max(1, Math.round(gainSeconds / 60)) })
      : t('customJourney.suggestion.onlyOption');
  const subtitle = strong ? walkTo : t('customJourney.suggestion.walk', { count: walkMinutes });

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surfaceFloating },
        strong && { borderColor: withAlpha(colors.walk, TIP_EDGE), borderWidth: Border.default },
      ]}
    >
      {/* The tint over a solid base: the sheet behind is glass. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: strong ? withAlpha(colors.walk, TIP_FILL) : colors.surfaceNested },
        ]}
      />

      <View style={styles.head}>
        <View style={[styles.tile, { backgroundColor: strong ? colors.walk : colors.trackFill }]}>
          <Icon name="walk" size="md" color={strong ? 'onStatus' : 'textPrimary'} weight="semibold" />
        </View>
        <View style={styles.headText}>
          {strong && (
            <Text variant="caption1" emphasized color="textSecondary" numberOfLines={1}>
              {t('customJourney.suggestion.tip')}
            </Text>
          )}
          <Text variant={strong ? 'title3' : 'headline'} numberOfLines={2}>{title}</Text>
          <Text variant="subheadline" color="textSecondary" numberOfLines={2}>{subtitle}</Text>
        </View>
      </View>

      {best ? (
        <View style={[styles.line, { backgroundColor: colors.surfaceGroup }]}>
          <LineBadge route={{ ...best.route, shortName: best.route.shortName ?? '' }} size="small" />
          <View style={styles.grow}>
            <Text variant="callout" emphasized numberOfLines={1}>
              {formatHeadsign(best.headsign)}
            </Text>
            <Text variant="footnote" color="textSecondary" numeric numberOfLines={2}>
              {[
                t('customJourney.suggestion.leavesIn', { count: Math.max(0, Math.round((Date.parse(best.departs) - nowMs) / 60_000)) }),
                t('journey.sheet.arriveAt', { time: formatClockTime(best.arrives) }),
              ].join(' · ')}
            </Text>
          </View>
        </View>
      ) : (
        <Text variant="subheadline" color="textSecondary">{t('customJourney.suggestion.nothing')}</Text>
      )}

      <View style={styles.actions}>
        {best && onGo && (
          <Button variant="prominent" size="md" icon="walk" label={t('customJourney.suggestion.go')} loading={busy} onPress={onGo} style={styles.grow} />
        )}
        <Button variant="plain" size="md" label={t(strong ? 'customJourney.suggestion.stay' : 'common.close')} onPress={onDismiss} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    padding: Space.md,
    gap: Space.md,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, gap: Space.xxs },
  // Concentric with the card: Radius.xl less its padding.
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    padding: Space.sm,
    borderRadius: Radius.md,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  grow: { flex: 1 },
});
