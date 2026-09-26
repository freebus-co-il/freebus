import { IconWalk } from '@tabler/icons-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { LegStrip, NowTag, StepCardFrame } from '@/features/trip/step-card';
import type { LegCard } from '@/features/trip/step-cards';
import { formatClockTime, formatDistanceMeters, formatDurationMinutes } from '@/lib/format';
import { readableTextColor, WALK_LEG_COLOR } from '@/lib/route-color';

import { journeyCardModel } from './journey-card-model';
import type { JourneyState } from './types';

const MARKER_SIZE = 28;

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
  const model = journeyCardModel(card, state, itinerary, destinationLabel, t, FORMAT_BAG);

  return (
    <StepCardFrame done={done}>
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
        <ThemedText type="small" themeColor="textSecondary" accessibilityLabel={t('journey.pip.arrive', { time: formatClockTime(state.arrivalTime) })}>
          {formatClockTime(state.arrivalTime)}
        </ThemedText>
      </View>

      <View style={styles.headRow}>
        {model.route ? (
          <LineBadge route={model.route} />
        ) : (
          <View style={[styles.marker, { backgroundColor: WALK_LEG_COLOR }]}>
            <IconWalk size={16} color={readableTextColor(WALK_LEG_COLOR)} />
          </View>
        )}
        <View style={styles.lines}>
          <ThemedText
            type="subtitle"
            // Two lines, not one: on `riding` the headline IS the get-off stop
            // -- the point of the card -- and Israeli stop names ("Beit
            // LaBanim/Derekh HaBanim") run long enough to ellipsise at one
            // line. The supporting line below stays single-line; this still
            // satisfies the spec's two-row rule, since a row may wrap.
            numberOfLines={2}
            themeColor={model.tone === 'alert' ? 'danger' : undefined}
          >
            {model.headline}
          </ThemedText>
          {model.supporting !== null && (
            <ThemedText type="default" themeColor="textSecondary" numberOfLines={1}>
              {model.supporting}
            </ThemedText>
          )}
        </View>
        {current && <NowTag />}
      </View>

      {model.canSwitchLine && onSwitchLine && (
        <Pressable
          accessibilityRole="button"
          onPress={onSwitchLine}
          // Matches the screen's own back button (`app/journey.tsx`): `Spacing.two`
          // on a ~20pt text control gives a target of only ~36pt.
          hitSlop={Spacing.three}
          style={styles.switchRow}
        >
          <ThemedText type="small" themeColor="textSecondary">
            {t('journey.switchLine.trigger')}
          </ThemedText>
        </Pressable>
      )}
    </StepCardFrame>
  );
}

const styles = StyleSheet.create({
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  stripSlot: {
    flex: 1,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  lines: {
    flex: 1,
    gap: Spacing.half,
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // At the card's end, quiet: a fallback for the one rider who needs it, not
  // a competitor for the two rows above.
  switchRow: {
    alignSelf: 'flex-end',
  },
});
