import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { Card, Icon, Opacity, Radius, Size, Space, Tag, Text, useColors } from '@/design-system';
import { buildJourneyRail } from '@/features/journey/journey-rail';
import { formatHeadsign, tripNumberOf } from '@/features/results/itinerary-facts';
import { formatClockTime, formatDistanceMeters, formatDurationMinutes } from '@/lib/format';
import { withAlpha } from '@/lib/route-color';

import { LineOptionChips } from './line-option-chips';
import type { LegCard } from './step-cards';

/** The legs a card is NOT about, on its strip: the design system's "dimmed",
 *  close to the map's own fade, so the strip and the map say "this one" the
 *  same way. */
const UNFOCUSED_SEGMENT_ALPHA = Opacity.dimmed;
/** The leg strip's thickness (design-system.md 5.7, LegStrip). */
const STRIP_HEIGHT = Space.xs + Space.xxs;
/** Wide enough for "00:00" at `subheadline`, so the board and get-off times
 *  line up into one column. */
const TIME_COLUMN = 44;

/**
 * The journey as one thin bar, a segment per leg sized by its time, with the
 * card's own leg lit and the rest faded. Tells a rider mid-swipe where in the
 * journey this card sits without a "step 3 of 5" to count.
 */
export function LegStrip({ itinerary, focusLegIndex }: { itinerary: Itinerary; focusLegIndex: number | null }) {
  const colors = useColors();
  const rail = buildJourneyRail(itinerary);
  return (
    <View
      style={[styles.strip, { backgroundColor: colors.separator }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {rail.segments.map((segment) => {
        // A walk in the design system's walk colour; a ride in its operator's.
        const color = segment.kind === 'walk' ? colors.walk : segment.color;
        return (
          <View
            key={segment.legIndex}
            style={{
              // A zero-second leg still gets a sliver, so it can be the lit one.
              flex: Math.max(segment.seconds, rail.totalSeconds * 0.03),
              backgroundColor:
                focusLegIndex === null || focusLegIndex === segment.legIndex
                  ? color
                  : withAlpha(color, UNFOCUSED_SEGMENT_ALPHA),
            }}
          />
        );
      })}
    </View>
  );
}

/** The shared surface of every card in the trip and journey carousels.
 *  Cards rather than inline rows: they float over a full-bleed map, which is
 *  its own background, and a carousel item with no edge has nothing to snap
 *  between. `floating` (solid, never glass -- these are content) over a map;
 *  `default` where the same card sits on a grouped page. A finished leg on a
 *  running journey is `done`: still readable, plainly behind the rider. */
export function StepCardFrame({
  children, done = false, variant = 'floating',
}: { children: ReactNode; done?: boolean; variant?: 'floating' | 'default' }) {
  return (
    <Card variant={variant} done={done} style={styles.card}>
      {children}
    </Card>
  );
}

/** The leg the running journey is on. */
export function NowTag() {
  const { t } = useTranslation();
  return <Tag tone="live" label={t('journey.now')} />;
}

/** A walk's leading glyph: the walk colour, as on the strip and the map. */
function WalkMarker() {
  const colors = useColors();
  return (
    <View style={[styles.marker, { backgroundColor: colors.walk }]}>
      <Icon name="walk" size="sm" color="onStatus" weight="semibold" />
    </View>
  );
}

/**
 * One leg, as a card. A walk says where to and how far; a ride says what to
 * catch, where, and -- given the same weight -- where to get off, which is
 * the part an unfamiliar rider actually loses sleep over.
 */
export function LegStepCard({
  card, itinerary, done = false, current = false,
}: {
  card: LegCard;
  itinerary: Itinerary;
  /** A leg the running journey has already finished. */
  done?: boolean;
  /** The leg the running journey is on. */
  current?: boolean;
}) {
  const { t } = useTranslation();

  if (card.kind === 'walk') {
    const { leg } = card;
    return (
      <StepCardFrame done={done}>
        <LegStrip itinerary={itinerary} focusLegIndex={card.legIndex} />
        <View style={styles.headRow}>
          <WalkMarker />
          <Text variant="headline" numeric style={styles.grow} numberOfLines={1}>
            {t('trip.walkFor', { duration: formatDurationMinutes(leg.durationSeconds) })}
          </Text>
          {current && <NowTag />}
          <Text variant="subheadline" emphasized numeric color="textSecondary">
            {formatClockTime(card.startsAt)}
          </Text>
        </View>
        <Text variant="body" numberOfLines={2}>
          {card.final
            ? t('trip.toDestination')
            : t('trip.toPlace', { name: leg.to.name ?? t('trip.unnamedStop') })}
        </Text>
        <Text variant="subheadline" color="textSecondary" numeric>
          {formatDistanceMeters(leg.distanceMeters)}
        </Text>
      </StepCardFrame>
    );
  }

  const { leg } = card;
  const headsign = leg.headsign?.trim() ? formatHeadsign(leg.headsign) : '';
  const rideSeconds = (new Date(leg.to.arrivalTime).getTime() - new Date(leg.from.departureTime).getTime()) / 1000;
  const trainNumber = tripNumberOf(leg);
  // A train's number sits with the ride's other small facts rather than on the
  // "towards X" line: that line is one line long, and the number truncating
  // the destination would trade the fact a rider boards by for a confirmation.
  const facts = [
    trainNumber === null ? null : t('results.trainNumber', { number: trainNumber }),
    t('results.stops', { count: leg.numStops }),
    formatDurationMinutes(rideSeconds),
    card.waitSeconds !== null ? t('trip.wait', { duration: formatDurationMinutes(card.waitSeconds) }) : null,
  ].filter((part): part is string => part !== null).join(' · ');

  return (
    <StepCardFrame done={done}>
      <LegStrip itinerary={itinerary} focusLegIndex={card.legIndex} />
      <View style={styles.headRow}>
        <LineBadge route={leg.route} />
        <Text variant="subheadline" numberOfLines={1} style={styles.grow}>
          {headsign !== '' ? t('results.towards', { name: headsign }) : ''}
        </Text>
        {current && <NowTag />}
      </View>
      <View style={styles.stopRow}>
        <Text variant="subheadline" emphasized numeric color="textSecondary" style={styles.time}>
          {formatClockTime(leg.from.departureTime)}
        </Text>
        <Text variant="body" numberOfLines={1} style={styles.grow}>
          {t('trip.boardAt', { name: leg.from.stop.name ?? t('trip.unnamedStop') })}
        </Text>
      </View>
      <Text variant="subheadline" color="textSecondary" numeric style={styles.facts}>
        {facts}
      </Text>
      <View style={styles.stopRow}>
        <Text variant="subheadline" emphasized numeric color="textSecondary" style={styles.time}>
          {formatClockTime(leg.to.arrivalTime)}
        </Text>
        <Text variant="headline" numberOfLines={2} style={styles.grow}>
          {t('trip.getOffAt', { name: leg.to.stop.name ?? t('trip.unnamedStop') })}
        </Text>
      </View>
      <LineOptionChips leg={leg} />
    </StepCardFrame>
  );
}

const styles = StyleSheet.create({
  card: {
    // Fills the carousel's stretched row, so every card is as tall as the
    // tallest rather than sitting short inside it.
    flex: 1,
  },
  strip: {
    flexDirection: 'row',
    height: STRIP_HEIGHT,
    borderRadius: Radius.xs,
    overflow: 'hidden',
    gap: Space.xxs,
    marginBottom: Space.xs,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  marker: {
    width: Size.leadingTile,
    height: Size.leadingTile,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grow: {
    flex: 1,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Space.sm,
  },
  // Fixed width so the board and get-off times line up into one column.
  time: {
    width: TIME_COLUMN,
  },
  // Indented under the times, so the ride's facts read as belonging between
  // the stop the rider boards at and the one they get off at.
  facts: {
    marginStart: TIME_COLUMN + Space.sm,
  },
});
