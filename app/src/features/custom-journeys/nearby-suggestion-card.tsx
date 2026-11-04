import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Button, Glass, Icon, IconButton, Radius, Size, Space, Text, useColors } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';

import type { NearbyOption } from './nearby-options';

/** The walk dot that leads the hint and the card: the walk legs' amber, so
 *  it reads as the same idea as the walk the map draws to the stop. */
const DOT = 28;

/**
 * The stop worth walking to instead (or the one the rider tapped on the map),
 * floating over the map just above the sheet: the sheet keeps saying what the
 * rider is doing now, and this is an offer beside it. Liquid Glass, like the
 * map's other floating chrome; only its walk dot carries a colour.
 *
 * The app's own suggestion (`strong`) starts as a one-line hint, so it costs
 * the map almost nothing; a tap opens it into the card with the line, the
 * walk, and the three answers: switch to that stop, see the walk there on the
 * map, or not now (the corner's close button). A tap on the card's head folds
 * it back into the hint. A stop the rider tapped opens straight into the card,
 * with a neutral dot, since they asked for it.
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
        style={[styles.hintTarget, style]}
      >
        {/* Interactive: the glass itself answers the touch, so nothing dims. */}
        <Glass interactive shape="capsule" style={styles.hint}>
          {dot}
          <Text variant="subheadline" emphasized numberOfLines={1} style={styles.shrink}>{hint}</Text>
          <Icon name="chevronUp" size="sm" color="textSecondary" weight="semibold" />
        </Glass>
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
    <Glass shape="rounded" style={[styles.card, style]}>
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
    </Glass>
  );
}

const styles = StyleSheet.create({
  // Hugs its text and sits at the line's start, like a chip, not a banner.
  hintTarget: { alignSelf: 'flex-start', maxWidth: '100%' },
  hint: {
    minHeight: Size.touchMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingStart: Space.sm,
    paddingEnd: Space.md,
  },
  card: {
    borderRadius: Radius.xl,
    padding: Space.md,
    gap: Space.md,
    // Glass clips by default; "Switch stop" is glass too and stretches past
    // its frame under a touch.
    overflow: 'visible',
  },
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
