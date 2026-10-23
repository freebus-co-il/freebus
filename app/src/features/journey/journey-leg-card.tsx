import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { Button, Card, Icon, Radius, Size, Space, Text, useColors } from '@/design-system';
import { LegStrip, NowTag } from '@/features/trip/step-card';
import type { LegCard } from '@/features/trip/step-cards';
import { formatClockTime, formatDistanceMeters, formatDurationMinutes } from '@/lib/format';

import { journeyCardModel } from './journey-card-model';
import type { JourneyState } from './types';

// Hoist the format bag to module level: `journeyCardModel` depends on these
// functions, and rebuilding the object on every render is wasteful.
const FORMAT_BAG = {
  clock: formatClockTime,
  distance: formatDistanceMeters,
  duration: formatDurationMinutes,
};

/**
 * One leg of a RUNNING journey: two rows, three facts, and nothing else.
 *
 * The trip screen's `LegStepCard` is the verbose twin of this -- read at a
 * desk, before committing, when comparing plans. This one is read one-handed
 * on a moving bus, so everything the rider has already acted on is gone: the
 * stop they boarded at, the time they boarded, the length of the ride, and
 * the list of buses they did not get on.
 *
 * What it says comes entirely from `journeyCardModel`; this file is layout.
 * A floating card, solid rather than glass: it is content over the map, and a
 * carousel item with no edge has nothing to snap between.
 */
export function JourneyLegCard({
  card, state, itinerary, destinationLabel, done = false, current = false, onSwitchLine,
}: {
  card: LegCard;
  state: JourneyState;
  itinerary: Itinerary;
  destinationLabel: string;
  /** A leg the journey has already finished. */
  done?: boolean;
  /** The leg the journey is on. */
  current?: boolean;
  /** Opens the line switcher. Omitted where switching makes no sense. */
  onSwitchLine?: () => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const model = journeyCardModel(card, state, itinerary, destinationLabel, t, FORMAT_BAG);

  return (
    <Card variant="floating" done={done} style={styles.card}>
      {/* The whole journey and its end, on one row that already existed. This
          is what lets the overview card go: its rail and its arrival time are
          both here, on every card, in every phase. */}
      <View style={styles.stripRow}>
        <View style={styles.stripSlot}>
          <LegStrip itinerary={itinerary} focusLegIndex={card.legIndex} />
        </View>
        {/* A bare clock time next to a strip that is itself
            `accessibilityElementsHidden` (see `LegStrip`) would otherwise
            announce as a naked number -- give it the same label the PiP
            widget uses for the same fact. */}
        <Text
          variant="subheadline"
          color="textSecondary"
          numeric
          accessibilityLabel={t('journey.pip.arrive', { time: formatClockTime(state.arrivalTime) })}
        >
          {formatClockTime(state.arrivalTime)}
        </Text>
      </View>

      <View style={styles.headRow}>
        {model.route ? (
          <LineBadge route={model.route} />
        ) : (
          <View style={[styles.marker, { backgroundColor: colors.walk }]}>
            <Icon name="walk" size="sm" color="onStatus" weight="semibold" />
          </View>
        )}
        <View style={styles.lines}>
          <Text
            variant="title2"
            // Two lines, not one: on `riding` the headline IS the get-off stop
            // -- the point of the card -- and Israeli stop names ("Beit
            // LaBanim/Derekh HaBanim") run long enough to ellipsise at one
            // line. The supporting line below stays single-line; this still
            // satisfies the spec's two-row rule, since a row may wrap.
            numberOfLines={2}
            color={model.tone === 'alert' ? 'danger' : 'textPrimary'}
          >
            {model.headline}
          </Text>
          {model.supporting !== null && (
            <Text variant="body" color="textSecondary" numberOfLines={1}>
              {model.supporting}
            </Text>
          )}
        </View>
        {current && <NowTag />}
      </View>

      {/* At the card's end, quiet: a fallback for the one rider who needs it,
          not a competitor for the two rows above. A plain button at `md`, not
          `sm`: the control's own height is then the full touch target, where
          a 32pt text control needed a hit slop to be hittable. */}
      {model.canSwitchLine && onSwitchLine && (
        <Button
          variant="plain"
          size="md"
          label={t('journey.switchLine.trigger')}
          onPress={onSwitchLine}
          style={styles.switchButton}
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  // Fills the carousel's stretched row, so every card is as tall as the
  // tallest rather than sitting short inside it.
  card: {
    flex: 1,
  },
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  stripSlot: {
    flex: 1,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  lines: {
    flex: 1,
    gap: Space.xxs,
  },
  // The walk's stand-in for a line badge: a round walk-coloured tile the
  // width of a row's leading slot.
  marker: {
    width: Size.leadingTile,
    height: Size.leadingTile,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchButton: {
    alignSelf: 'flex-end',
  },
});
