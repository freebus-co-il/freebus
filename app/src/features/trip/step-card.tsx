import { IconWalk } from '@tabler/icons-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { buildJourneyRail } from '@/features/journey/journey-rail';
import { formatHeadsign, tripNumberOf } from '@/features/results/itinerary-facts';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime, formatDistanceMeters, formatDurationMinutes } from '@/lib/format';
import { readableTextColor, WALK_LEG_COLOR, withAlpha } from '@/lib/route-color';

import { LineOptionChips } from './line-option-chips';
import type { LegCard } from './step-cards';

/** A finished leg on a running journey: still readable, plainly behind the
 *  rider -- the same fade the old step list gave its history. */
const DONE_OPACITY = 0.45;
/** The legs a card is NOT about, on its strip. Matches the map's dimming, so
 *  the strip and the map say "this one" the same way. */
const UNFOCUSED_SEGMENT_ALPHA = 0.25;
const STRIP_HEIGHT = 4;
const MARKER_SIZE = 28;

/**
 * The journey as one thin bar, a segment per leg sized by its time, with the
 * card's own leg lit and the rest faded. Tells a rider mid-swipe where in the
 * journey this card sits without a "step 3 of 5" to count.
 */
export function LegStrip({ itinerary, focusLegIndex }: { itinerary: Itinerary; focusLegIndex: number | null }) {
  const theme = useTheme();
  const rail = buildJourneyRail(itinerary);
  return (
    <View
      style={[styles.strip, { backgroundColor: theme.borderMuted }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {rail.segments.map((segment) => (
        <View
          key={segment.legIndex}
          style={{
            // A zero-second leg still gets a sliver, so it can be the lit one.
            flex: Math.max(segment.seconds, rail.totalSeconds * 0.03),
            backgroundColor:
              focusLegIndex === null || focusLegIndex === segment.legIndex
                ? segment.color
                : withAlpha(segment.color, UNFOCUSED_SEGMENT_ALPHA),
          }}
        />
      ))}
    </View>
  );
}

/** The shared surface of every card in the trip and journey carousels.
 *  These stay panels rather than inline rows: they float over a full-bleed
 *  map, which is its own background, and a carousel item with no edge has
 *  nothing to snap between. */
export function StepCardFrame({ children, done = false }: { children: ReactNode; done?: boolean }) {
  const theme = useTheme();
  return (
    <ThemedView
      type="background"
      style={[styles.card, { borderColor: theme.borderMuted }, done && styles.done]}
    >
      {children}
    </ThemedView>
  );
}

export function NowTag() {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View style={[styles.nowTag, { backgroundColor: theme.text }]}>
      <ThemedText type="smallBold" themeColor="background">
        {t('journey.now')}
      </ThemedText>
    </View>
  );
}

/**
 * One leg, as a card. A walk says where to and how far; a ride says what to
 * catch, where, and -- given the same weight -- where to get off, which is
 * the part an unfamiliar rider actually loses sleep over.
 */
export function LegStepCard({
  card, itinerary, done = false, current = false, onChooseLine,
}: {
  card: LegCard;
  itinerary: Itinerary;
  /** A leg the running journey has already finished. */
  done?: boolean;
  /** The leg the running journey is on. */
  current?: boolean;
  /** Set on a running journey: the rider picks which of the ride's lines they
   *  are on. Without it the ride's other lines are only listed. */
  onChooseLine?: (tripId: string) => void;
}) {
  const { t } = useTranslation();

  if (card.kind === 'walk') {
    const { leg } = card;
    return (
      <StepCardFrame done={done}>
        <LegStrip itinerary={itinerary} focusLegIndex={card.legIndex} />
        <View style={styles.headRow}>
          <View style={[styles.marker, { backgroundColor: WALK_LEG_COLOR }]}>
            <IconWalk size={16} color={readableTextColor(WALK_LEG_COLOR)} />
          </View>
          <ThemedText type="defaultBold" style={styles.grow} numberOfLines={1}>
            {t('trip.walkFor', { duration: formatDurationMinutes(leg.durationSeconds) })}
          </ThemedText>
          {current && <NowTag />}
          <ThemedText type="smallBold" themeColor="textSecondary">
            {formatClockTime(card.startsAt)}
          </ThemedText>
        </View>
        <ThemedText type="default" numberOfLines={2}>
          {card.final
            ? t('trip.toDestination')
            : t('trip.toPlace', { name: leg.to.name ?? t('trip.unnamedStop') })}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {formatDistanceMeters(leg.distanceMeters)}
        </ThemedText>
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
        <ThemedText type="small" numberOfLines={1} style={styles.grow}>
          {headsign !== '' ? t('results.towards', { name: headsign }) : ''}
        </ThemedText>
        {current && <NowTag />}
      </View>
      <View style={styles.stopRow}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.time}>
          {formatClockTime(leg.from.departureTime)}
        </ThemedText>
        <ThemedText type="default" numberOfLines={1} style={styles.grow}>
          {t('trip.boardAt', { name: leg.from.stop.name ?? t('trip.unnamedStop') })}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.facts}>
        {facts}
      </ThemedText>
      <View style={styles.stopRow}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.time}>
          {formatClockTime(leg.to.arrivalTime)}
        </ThemedText>
        <ThemedText type="defaultBold" numberOfLines={2} style={styles.grow}>
          {t('trip.getOffAt', { name: leg.to.stop.name ?? t('trip.unnamedStop') })}
        </ThemedText>
      </View>
      <LineOptionChips leg={leg} onChoose={onChooseLine} />
    </StepCardFrame>
  );
}

const styles = StyleSheet.create({
  card: {
    // Fills the carousel's stretched row, so every card is as tall as the
    // tallest rather than sitting short inside it.
    flex: 1,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  done: {
    opacity: DONE_OPACITY,
  },
  strip: {
    flexDirection: 'row',
    height: STRIP_HEIGHT,
    borderRadius: STRIP_HEIGHT / 2,
    overflow: 'hidden',
    gap: 2,
    marginBottom: Spacing.one,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grow: {
    flex: 1,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  // Fixed width so the board and get-off times line up into one column.
  time: {
    width: 44,
  },
  // Indented under the times, so the ride's facts read as belonging between
  // the stop the rider boards at and the one they get off at.
  facts: {
    marginStart: 44 + Spacing.two,
  },
  nowTag: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: 999,
  },
});
