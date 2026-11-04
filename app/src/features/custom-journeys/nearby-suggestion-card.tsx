import { useTranslation } from 'react-i18next';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Border, Button, Icon, IconButton, Radius, Space, Text, useColors, withAlpha } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';

import type { NearbyOption } from './nearby-options';

/** The tip's tint: the walk legs' amber, so the card reads as the same idea
 *  as the walk the map draws to the stop. */
const TIP_FILL = 0.14;
const TIP_EDGE = 0.5;
/** The leading walk tile. */
const TILE = 36;

/**
 * The stop the map lit up (or the one the rider tapped): which line to take
 * from it, how far it is, and what walking there wins. "Go there" puts that
 * run on the ride and points the journey at the stop.
 *
 * It floats over the map, just above the sheet, rather than in it: the sheet
 * keeps saying what the rider is doing now, and this is an offer beside it
 * that they can take or wave off without losing their place.
 *
 * The one the app suggests on its own (`strong`) is a tip: tinted with the
 * walk amber and led by what it wins ("Arriving 4 min sooner"). A stop the
 * rider tapped is the same card, neutral, led by its name.
 */
export function NearbySuggestionCard({ option, strong, gainSeconds, nowMs, busy, onGo, onDismiss, style }: {
  option: NearbyOption;
  strong: boolean;
  gainSeconds: number | null;
  nowMs: number;
  busy: boolean;
  onGo: (() => void) | null;
  onDismiss: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const best = option.best;
  const walkMinutes = Math.max(1, Math.round(option.walkSeconds / 60));
  const name = option.name ?? t('customJourney.suggestion.unnamedStop');
  const walk = t('customJourney.suggestion.walk', { count: walkMinutes });

  const title = !strong
    ? name
    : gainSeconds !== null
      ? t('customJourney.suggestion.sooner', { count: Math.max(1, Math.round(gainSeconds / 60)) })
      : t('customJourney.suggestion.onlyOption');
  const subtitle = strong ? t('customJourney.suggestion.walkTo', { walk, name }) : walk;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surfaceFloating,
          borderColor: strong ? withAlpha(colors.walk, TIP_EDGE) : colors.controlEdge,
        },
        style,
      ]}
    >
      {/* The tint over a solid base: the map shows through anything less.
          Rounded itself rather than clipped by the card, because the card
          must not clip: "Go there" is glass, which stretches under a touch. */}
      {strong && (
        <View pointerEvents="none" style={[styles.tint, { backgroundColor: withAlpha(colors.walk, TIP_FILL) }]} />
      )}

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
          <Text variant="headline" numberOfLines={2}>{title}</Text>
          <Text variant="footnote" color="textSecondary" numberOfLines={2}>{subtitle}</Text>
        </View>
        <IconButton
          icon="close"
          variant="plain"
          size="sm"
          color="textSecondary"
          accessibilityLabel={t(strong ? 'customJourney.suggestion.stay' : 'common.close')}
          onPress={onDismiss}
        />
      </View>

      {best ? (
        <View style={styles.line}>
          <LineBadge route={{ ...best.route, shortName: best.route.shortName ?? '' }} size="small" />
          <Text variant="subheadline" emphasized numberOfLines={1} style={styles.shrink}>
            {formatHeadsign(best.headsign)}
          </Text>
          <Text variant="subheadline" color="textSecondary" numeric numberOfLines={1}>
            {t('customJourney.suggestion.leavesIn', { count: Math.max(0, Math.round((Date.parse(best.departs) - nowMs) / 60_000)) })}
          </Text>
        </View>
      ) : (
        <Text variant="subheadline" color="textSecondary">{t('customJourney.suggestion.nothing')}</Text>
      )}

      {best && onGo && (
        <Button variant="prominent" size="md" icon="walk" label={t('customJourney.suggestion.go')} loading={busy} onPress={onGo} fullWidth />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    borderWidth: Border.default,
    padding: Space.md,
    gap: Space.md,
  },
  tint: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, borderRadius: Radius.xl - Border.default },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, gap: Space.xxs },
  line: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  shrink: { flexShrink: 1 },
});
