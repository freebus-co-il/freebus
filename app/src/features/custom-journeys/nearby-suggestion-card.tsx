import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Border, Button, Icon, IconButton, Opacity, Radius, Size, Space, Text, useColors, withAlpha } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';

import type { NearbyOption } from './nearby-options';

/** The tip's tint: the walk legs' amber, so the hint reads as the same idea
 *  as the walk the map draws to the stop. */
const TIP_FILL = 0.14;
const TIP_EDGE = 0.5;
/** The walk dot that leads the hint and the card. */
const DOT = 28;

/**
 * The stop worth walking to instead (or the one the rider tapped on the map),
 * floating over the map just above the sheet: the sheet keeps saying what the
 * rider is doing now, and this is an offer beside it.
 *
 * The app's own suggestion (`strong`) starts as a one-line hint, so it costs
 * the map almost nothing; a tap opens it into the card with the line, the
 * walk, and the three answers: switch to that stop, see the walk there on the
 * map, or not now (the corner's close button). A tap on the card's head folds
 * it back into the hint. A stop the rider tapped opens straight into the card,
 * neutral rather than amber, since they asked for it.
 */
export function NearbySuggestionCard({ option, strong, gainSeconds, nowMs, busy, previewing, onGo, onPreview, onDismiss, style }: {
  option: NearbyOption;
  strong: boolean;
  gainSeconds: number | null;
  nowMs: number;
  busy: boolean;
  /** The walk to this stop is on the map. */
  previewing: boolean;
  onGo: (() => void) | null;
  /** Shows or hides the walk to this stop on the map; null when there is
   *  nowhere to walk from. */
  onPreview: (() => void) | null;
  onDismiss: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const [expanded, setExpanded] = useState(!strong);

  const best = option.best;
  const walkMinutes = Math.max(1, Math.round(option.walkSeconds / 60));
  const gainMinutes = gainSeconds === null ? null : Math.max(1, Math.round(gainSeconds / 60));
  const name = option.name ?? t('customJourney.suggestion.unnamedStop');
  const walk = t('customJourney.suggestion.walk', { count: walkMinutes });

  const surface = {
    backgroundColor: colors.surfaceFloating,
    borderColor: strong ? withAlpha(colors.walk, TIP_EDGE) : colors.controlEdge,
  };
  // Rounded itself rather than clipped by its parent: the card must not clip,
  // because the prominent button is glass, which stretches under a touch.
  const tint = strong && (
    <View
      pointerEvents="none"
      style={[
        styles.tint,
        { backgroundColor: withAlpha(colors.walk, TIP_FILL), borderRadius: expanded ? Radius.xl - Border.default : Radius.full },
      ]}
    />
  );
  const dot = (
    <View style={[styles.dot, { backgroundColor: strong ? colors.walk : colors.trackFill }]}>
      <Icon name="walk" size="sm" color={strong ? 'onStatus' : 'textPrimary'} weight="semibold" />
    </View>
  );

  if (!expanded) {
    const hint = gainMinutes !== null
      ? t('customJourney.suggestion.hint', { count: gainMinutes })
      : t('customJourney.suggestion.hintOnly');
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={hint}
        accessibilityHint={t('customJourney.suggestion.expand')}
        onPress={() => setExpanded(true)}
        style={({ pressed }) => [styles.hint, surface, pressed && styles.pressed, style]}
      >
        {tint}
        {dot}
        <Text variant="subheadline" emphasized numberOfLines={1} style={styles.shrink}>{hint}</Text>
        <Icon name="chevronUp" size="sm" color="textSecondary" weight="semibold" />
      </Pressable>
    );
  }

  const title = !strong
    ? name
    : gainMinutes !== null
      ? t('customJourney.suggestion.sooner', { count: gainMinutes })
      : t('customJourney.suggestion.onlyOption');
  const subtitle = strong ? t('customJourney.suggestion.walkTo', { walk, name }) : walk;

  return (
    <View style={[styles.card, surface, style]}>
      {tint}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[title, subtitle].join(', ')}
        accessibilityHint={strong ? t('customJourney.suggestion.collapse') : undefined}
        disabled={!strong}
        onPress={() => setExpanded(false)}
        style={styles.head}
      >
        {dot}
        <View style={styles.headText}>
          <Text variant="headline" numberOfLines={2}>{title}</Text>
          <Text variant="footnote" color="textSecondary" numberOfLines={2}>{subtitle}</Text>
        </View>
        <IconButton
          icon="close"
          variant="plain"
          size="sm"
          color="textSecondary"
          accessibilityLabel={t(strong ? 'customJourney.suggestion.notNow' : 'common.close')}
          onPress={onDismiss}
        />
      </Pressable>

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

      <View style={styles.actions}>
        {best && onGo && (
          <Button variant="prominent" size="md" label={t('customJourney.suggestion.switch')} loading={busy} onPress={onGo} style={styles.grow} />
        )}
        {onPreview && (
          <Button
            variant="secondary"
            size="md"
            label={t(previewing ? 'customJourney.suggestion.hideWalk' : 'customJourney.suggestion.showWalk')}
            onPress={onPreview}
            style={styles.grow}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Hugs its text and sits at the line's start, like a chip, not a banner.
  hint: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: Size.touchMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingStart: Space.sm,
    paddingEnd: Space.md,
    borderRadius: Radius.full,
    borderWidth: Border.default,
  },
  pressed: { opacity: Opacity.pressed },
  card: {
    borderRadius: Radius.xl,
    borderWidth: Border.default,
    padding: Space.md,
    gap: Space.md,
  },
  tint: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  headText: { flex: 1, gap: Space.xxs },
  line: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  shrink: { flexShrink: 1 },
  grow: { flex: 1 },
});
