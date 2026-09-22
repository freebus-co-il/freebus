import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Itinerary } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';


import { equallyGoodLines } from '@/features/trip/line-options';

import { itinerarySignature } from './group-itineraries';
import { departureFrequencyMinutes, firstTransitLeg, formatHeadsign, minutesUntil } from './itinerary-facts';
import { LegTimeline } from './leg-timeline';
import { RiskBadge } from './risk-badge';

/** Every card in the carousel is as tall as the tallest one, so a single
 *  group with a long list of departures would stretch all of them. Four is
 *  the most that fits on one unwrapped line at the narrowest phone width. */
const MAX_TIME_CHIPS = 4;

/** Past this, a countdown stops being useful and starts being arithmetic --
 *  "leave in 143 min" is a worse answer than "leave at 14:20". */
const LEAVE_COUNTDOWN_MAX_MINUTES = 60;

/** The ride's other lines shown beside its own before the rest collapse into
 *  "+N": the row also carries the stop and direction, and must stay one line. */
const MAX_OTHER_LINE_BADGES = 3;


export type ItineraryCardProps = {
  /** Same-pattern itineraries (see `groupItineraries`), earliest first. */
  instances: Itinerary[];
  /** Which instance is currently shown -- the one this card actually displays. */
  activeIndex: number;
  /** Fired when a time chip is tapped: picking a departure re-routes the map. */
  onSelectTime: (activeIndex: number) => void;
};

/**
 * One journey, ordered by what a rider standing in an unfamiliar place
 * actually needs, which is not the same as what is easiest to compare.
 *
 *   1. when to LEAVE, and when they arrive
 *   2. what to catch, from which stop, in which direction
 *   3. the shape of the effort (the leg timeline)
 *   4. duration / transfers / walking -- the comparators, quiet
 *   5. the other departures, and how often they come
 *
 * Duration does not lead. Leading with duration is right for a VERTICAL LIST,
 * where several rows sit on screen at once and the eye compares down a column
 * of durations. This card lives in a one-at-a-time carousel, so
 * comparison is temporal -- swipe, and remember -- and the top slot is better
 * spent on what makes THIS card actionable. Duration keeps a fixed position in
 * the meta row, so swiping still compares it positionally.
 *
 * No "selected" state of its own: being on screen IS being selected.
 */
export function ItineraryCard({ instances, activeIndex, onSelectTime }: ItineraryCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  // Held here rather than threaded down from the screen: a handful of cards
  // means a handful of 30s timers, which is nothing, and prop-drilling a clock
  // through the carousel would be noise.
  const now = useNow();

  const itinerary = instances[activeIndex] ?? instances[0]!;
  const times = instances.slice(0, MAX_TIME_CHIPS);
  const ride = firstTransitLeg(itinerary);
  // The other lines that do just as well for the first ride, shown together
  // as "70 / 10 / 202" -- lines that miss the connection or get the rider there
  // meaningfully later are fallbacks, shown with their cost on the trip's ride
  // card, not equals here.
  const otherLines = ride ? equallyGoodLines(ride) : [];
  // One card is one route through the same stops (see `itinerarySignature`),
  // so its departures can be on different lines; when they are, each time chip
  // says which.
  const mixedLines = new Set(times.map((instance) => firstTransitLeg(instance)?.route.id ?? '')).size > 1;
  const cadence = departureFrequencyMinutes(instances);

  // `itinerary.departureTime` is the DOOR departure -- the instant the rider
  // has to be walking, already net of the access walk. (Verified against
  // /plan: a 9-minute access walk puts this 9 minutes ahead of the ride's own
  // departure.) So the leave-by time needs no arithmetic here. What it needed
  // was to stop being rendered as if it were the ride's departure: shown as
  // the left half of "18:31 -> 19:30" it reads as the time the bus goes, and a
  // rider who believes that misses it by the length of their own walk.
  const minutesToLeave = minutesUntil(itinerary.departureTime, now);
  const departed = minutesToLeave < 0;
  const leaveLabel = departed
    ? t('results.leaveDeparted')
    : minutesToLeave < 1
      ? t('results.leaveNow')
      : minutesToLeave <= LEAVE_COUNTDOWN_MAX_MINUTES
        ? t('results.leaveIn', { count: minutesToLeave })
        : t('results.leaveAt', { time: formatClockTime(itinerary.departureTime) });

  const boardingStop = ride?.from.stop.name?.trim() ?? '';
  const headsign = ride?.headsign?.trim() ? formatHeadsign(ride.headsign) : '';
  const rideDetail = [boardingStop, headsign === '' ? '' : t('results.towards', { name: headsign })]
    .filter((part) => part !== '')
    .join(' · ');

  // Walking as TIME, not distance: every other number on this card is a
  // duration, and a rider in a city they don't know cannot convert "2.3 km"
  // into how tired they will be, but they can picture 28 minutes.
  const meta = [
    formatDurationMinutes(itinerary.durationSeconds),
    t('results.transfers', { count: itinerary.transfers }),
    t('results.walkingTime', { duration: formatDurationMinutes(itinerary.walkSeconds) }),
  ].join(' · ');

  // Addressed by CONTENT, not position: the trip screen looks the journey back
  // up out of the same react-query cache, and an index would quietly resolve to
  // a different one if a background refetch reordered the results.
  function openTrip() {
    router.push({
      pathname: '/trip',
      params: { signature: itinerarySignature(itinerary), departure: itinerary.departureTime },
    });
  }

  return (
    <Pressable onPress={openTrip} style={styles.pressable}>
        <ThemedView type="background" style={[styles.card, { borderColor: theme.borderMuted }]}>
        <View style={styles.heroRow}>
          <ThemedText type="subtitle" themeColor={departed ? 'textSecondary' : undefined}>
            {leaveLabel}
          </ThemedText>
          <ThemedText type="default" themeColor="textSecondary">
            {t('results.arriveAt', { time: formatClockTime(itinerary.arrivalTime) })}
          </ThemedText>
        </View>

        {ride && (
          <View style={styles.rideRow}>
            <LineBadge route={ride.route} />
            {otherLines.slice(0, MAX_OTHER_LINE_BADGES).map((option) => (
              <View key={option.tripId} style={styles.otherLine}>
                <ThemedText type="small" themeColor="textSecondary">/</ThemedText>
                <LineBadge route={option.route} size="small" />
              </View>
            ))}
            {otherLines.length > MAX_OTHER_LINE_BADGES && (
              <ThemedText type="small" themeColor="textSecondary">
                +{otherLines.length - MAX_OTHER_LINE_BADGES}
              </ThemedText>
            )}
            {rideDetail !== '' && (
              <ThemedText type="small" numberOfLines={1} style={styles.rideDetail}>
                {rideDetail}
              </ThemedText>
            )}
          </View>
        )}

        <LegTimeline legs={itinerary.legs} />

        <ThemedText type="small" themeColor="textSecondary">
          {meta}
        </ThemedText>

        {/* Only where there is a transfer to be at risk of. `transferAtRisk` is
            an itinerary-level flag, not a per-transfer one, so it cannot be
            pinned to a specific interchange -- but on a zero-transfer journey it
            is answering a question nobody asked. */}
        {itinerary.transfers > 0 && <RiskBadge transferAtRisk={itinerary.transferAtRisk} />}

        {(times.length > 1 || cadence !== null) && (
          <View style={styles.timesRow}>
            {times.length > 1 &&
              times.map((instance, index) => {
                const active = index === activeIndex;
                return (
                  <Pressable key={instance.departureTime} onPress={() => onSelectTime(index)}>
                    <View style={[styles.timeChip, { backgroundColor: active ? theme.text : theme.background }, active ? null : outline]}>
                      {mixedLines && firstTransitLeg(instance) && (
                        <LineBadge route={firstTransitLeg(instance)!.route} size="small" />
                      )}
                      <ThemedText type="small" themeColor={active ? 'background' : 'textSecondary'}>
                        {formatClockTime(instance.departureTime)}
                      </ThemedText>
                    </View>
                  </Pressable>
                );
              })}
            {cadence !== null && (
              <ThemedText type="small" themeColor="textSecondary" style={styles.cadence}>
                {t('results.frequency', { minutes: cadence })}
              </ThemedText>
            )}
          </View>
        )}
        </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Carries the stretched carousel height down to the card itself, so wrapping
  // the card in a Pressable does not leave it short inside the row.
  pressable: {
    flex: 1,
  },
  card: {
    // `flex: 1` so the card fills the carousel's stretched row height rather
    // than sitting short inside it.
    flex: 1,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  heroRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  rideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rideDetail: {
    flexShrink: 1,
  },
  otherLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  // Deliberately not wrapping: a card that grew a second row of chips would
  // drag every other card in the carousel up to its height.
  timesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  timeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: 999,
  },
  cadence: {
    flexShrink: 1,
  },
});
