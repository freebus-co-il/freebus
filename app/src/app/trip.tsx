import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePlanTrip } from '@/api/plan';
import { IconBack } from '@/components/directional-icon';
import { SnapCarousel } from '@/components/snap-carousel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useJourney } from '@/features/journey/journey-context';
import { shouldOfferReminder } from '@/features/journey/leave-reminder';
import { itinerarySignature } from '@/features/results/group-itineraries';
import { minutesUntil } from '@/features/results/itinerary-facts';
import { LegTimeline } from '@/features/results/leg-timeline';
import { TripMap } from '@/features/results/trip-map';
import { useSearch } from '@/features/search/search-context';
import { LegStepCard, LegStrip, StepCardFrame } from '@/features/trip/step-card';
import { buildStepCards, cardFocusLegIndex, type StepCard } from '@/features/trip/step-cards';
import { useVehicles } from '@/api/vehicles';
import { itineraryPredictions } from '@/features/results/vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';
import { placeLabel } from '@/lib/place';

/** Past this, a countdown is arithmetic rather than an answer. Matches
 *  `ItineraryCard`, so the number does not change character on navigation. */
const LEAVE_COUNTDOWN_MAX_MINUTES = 60;

/** The back chip's height below the safe area, plus breathing room: the part
 *  of the map's top it covers. */
const BACK_CHIP_CLEARANCE = 64;
/** `TripMap`'s own default for the edges nothing floats over. */
const MAP_EDGE_PADDING = 50;

/**
 * One journey, told one leg at a time over its own map.
 *
 * The map is the screen, as on the results screen this is opened from. The
 * first card is the whole journey; each swipe after it is one leg, and the
 * map zooms to that leg with the rest of the journey faded around it -- so a
 * rider reads one thing at a time without losing where it sits.
 *
 * The itinerary is NOT passed through route params -- it carries encoded
 * polylines and every intermediate stop, which is far too much to put in a
 * URL. Instead the params carry a content-derived address (the group
 * signature plus the chosen departure) and this screen re-issues the identical
 * `/plan` query, which react-query answers from the cache the results screen
 * already filled. Content-derived rather than positional on purpose: an index
 * would silently point at a different journey if a background refetch
 * reordered anything.
 */
export default function TripScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const now = useNow();
  const insets = useSafeAreaInsets();
  const { planQuery, destination } = useSearch();
  const { journey, start, pendingLeave, setLeaveReminder, cancelLeaveReminder } = useJourney();
  const { signature, departure } = useLocalSearchParams<{ signature?: string; departure?: string }>();

  const { data } = usePlanTrip(planQuery);

  const itinerary = useMemo(() => {
    if (!data || !signature || !departure) return null;
    return (
      data.itineraries.find(
        (candidate) => candidate.departureTime === departure && itinerarySignature(candidate) === signature,
      ) ?? null
    );
  }, [data, signature, departure]);

  const cards = useMemo(() => (itinerary ? buildStepCards(itinerary) : []), [itinerary]);
  // The buses this trip rides, each counting down to the stop the rider would
  // board it at.
  const tripIds = useMemo(
    () => (itinerary?.legs ?? []).flatMap((leg) => (leg.type === 'transit' ? [leg.tripId] : [])),
    [itinerary],
  );
  const { data: live } = useVehicles(tripIds);
  const vehiclePredictions = useMemo(() => itineraryPredictions(itinerary), [itinerary]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Measured, not guessed: the cards grow with their content. Memoized, since
  // the map re-fits whenever this changes identity.
  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  const mapEdgePadding = useMemo(
    () => ({
      top: insets.top + BACK_CHIP_CLEARANCE,
      right: MAP_EDGE_PADDING,
      bottom: bottomBarHeight + Spacing.three,
      left: MAP_EDGE_PADDING,
    }),
    [insets.top, bottomBarHeight],
  );

  /**
   * Hands this journey to the provider and opens the running screen.
   *
   * `replace`, not `push`: the trip screen is a preview of a journey that no
   * longer needs previewing once it is running, and leaving it on the stack
   * would let a back gesture land on a Start button for the journey the rider
   * is already inside.
   */
  const beginJourney = () => {
    if (!itinerary || !signature || !departure) return;
    const label = destination ? placeLabel(destination) : '';
    const go = async () => {
      await start(itinerary, signature, departure, label);
      router.replace('/journey');
    };

    // One journey at a time, per the spec. Replacing one silently would strip
    // the geofences and get-off alarm out from under a rider who is still
    // relying on them, so the swap is theirs to confirm.
    if (journey) {
      Alert.alert(t('journey.replace'), undefined, [
        { text: t('journey.keepGoing'), style: 'cancel' },
        { text: t('trip.start'), style: 'destructive', onPress: () => void go() },
      ]);
      return;
    }
    void go();
  };

  /**
   * Asks to be shouted at when it is time to leave, instead of starting a
   * journey the rider is an hour away from taking.
   *
   * Nothing about a running journey is touched: this arms two notifications
   * and stores the itinerary behind them. The journey itself begins when the
   * reminder is tapped -- see `LeaveReminderGate`.
   */
  const remindMe = () => {
    if (!itinerary || !signature || !departure) return;
    const label = destination ? placeLabel(destination) : '';
    void setLeaveReminder(itinerary, signature, departure, label).then((armed) => {
      // Only the rider can grant notifications, so a refusal is theirs to
      // answer: they are told rather than left with a button that did nothing.
      if (!armed) Alert.alert(t('trip.reminderUnavailable'));
    });
  };

  const back = (
    <Pressable onPress={() => router.back()} style={styles.backButton} hitSlop={Spacing.three}>
      <IconBack size={24} color={theme.text} />
    </Pressable>
  );

  if (!itinerary) {
    // Reachable when the plan cache has been dropped or refetched into
    // something that no longer holds this journey -- a stale deep link, or a
    // long enough time away from the app. Says so, rather than rendering an
    // empty timeline that looks like a trip with no steps in it.
    return (
      <ThemedView type="background" style={styles.container}>
        <SafeAreaView style={styles.unavailable}>
          {back}
          <ThemedText type="default">{t('trip.unavailable')}</ThemedText>
        </SafeAreaView>
      </ThemedView>
    );
  }

  // Far enough out that a rider would rather be fetched than sit here holding
  // a started journey -- see `shouldOfferReminder`.
  const offerReminder = shouldOfferReminder(itinerary.departureTime, now);
  // A reminder is set, and it is THIS trip's: the same plan address the screen
  // itself was opened with, so another trip's reminder never claims this
  // footer.
  const reminderForThisTrip =
    pendingLeave !== null && pendingLeave.signature === signature && pendingLeave.departure === departure;

  const minutesToLeave = minutesUntil(itinerary.departureTime, now);
  const leaveLabel =
    minutesToLeave < 0
      ? t('results.leaveDeparted')
      : minutesToLeave < 1
        ? t('results.leaveNow')
        : minutesToLeave <= LEAVE_COUNTDOWN_MAX_MINUTES
          ? t('results.leaveIn', { count: minutesToLeave })
          : t('results.leaveAt', { time: formatClockTime(itinerary.departureTime) });

  const renderCard = (card: StepCard) =>
    card.kind === 'overview' ? (
      <StepCardFrame>
        <LegStrip itinerary={itinerary} focusLegIndex={null} />
        {/* The same two numbers the results card led with, in the same order,
            so arriving here confirms the choice rather than restating it in a
            new shape the rider has to re-read. */}
        <ThemedText type="subtitle" themeColor={minutesToLeave < 0 ? 'textSecondary' : undefined}>
          {leaveLabel}
        </ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          {t('results.arriveAt', { time: formatClockTime(itinerary.arrivalTime) })} ·{' '}
          {formatDurationMinutes(itinerary.durationSeconds)}
        </ThemedText>
        <LegTimeline legs={itinerary.legs} />
      </StepCardFrame>
    ) : (
      <LegStepCard card={card} itinerary={itinerary} />
    );

  return (
    <ThemedView type="background" style={styles.container}>
      {/* No `style`: `TripMap`'s own `flex: 1` fills the screen in flow, which
          is what keeps it draggable (see `results.tsx`). */}
      <TripMap
        itinerary={itinerary}
        focusLegIndex={cardFocusLegIndex(cards[activeIndex])}
        edgePadding={mapEdgePadding}
        vehicles={live?.vehicles}
        vehiclePredictions={vehiclePredictions}
      />

      <SafeAreaView style={styles.header} edges={['top']} pointerEvents="box-none">
        <ThemedView type="background" style={styles.backChip}>
          {back}
        </ThemedView>
      </SafeAreaView>

      <SafeAreaView
        style={styles.bottomBar}
        edges={['bottom']}
        pointerEvents="box-none"
        onLayout={(event) => setBottomBarHeight(event.nativeEvent.layout.height)}
      >
        <SnapCarousel
          data={cards}
          keyExtractor={(card) => (card.kind === 'overview' ? 'overview' : `leg-${card.legIndex}`)}
          onActiveIndexChange={setActiveIndex}
          renderItem={renderCard}
        />
        {/* Pinned under the cards rather than on one of them: the commitment
            is to the whole journey, whichever leg the rider is reading. */}
        <View style={styles.footer}>
          {/* Start is ALWAYS here, however far off the departure is: setting
              out early to beat the traffic is a thing riders do, and the
              journey then begins on the run they can actually catch (see
              `withEarlierRunAtStart`) rather than on the one the search
              picked. The reminder is the second way to use a future trip, not
              a replacement for starting it. */}
          <Pressable
            accessibilityRole="button"
            onPress={beginJourney}
            style={[styles.startButton, { backgroundColor: theme.text }]}
          >
            <ThemedText type="defaultBold" themeColor="background">
              {t('trip.start')}
            </ThemedText>
          </Pressable>

          {offerReminder && (reminderForThisTrip ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => void cancelLeaveReminder()}
                style={[
                  styles.startButton,
                  styles.outlineButton,
                  { borderColor: theme.borderMuted, backgroundColor: theme.background },
                ]}
              >
                <ThemedText type="defaultBold">{t('trip.cancelReminder')}</ThemedText>
              </Pressable>
              {/* Under the button, not on it: what the rider needs to read is
                  the time they will be fetched at, and the button is how to
                  take that back. */}
              <ThemedText type="small" themeColor="textSecondary" style={styles.reminderNote}>
                {t('trip.reminderSet', { time: formatClockTime(itinerary.departureTime) })}
              </ThemedText>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={remindMe}
              style={[
                styles.startButton,
                styles.outlineButton,
                // A filled surface, not just a border: over a map a transparent
                // button reads as text someone left lying on the road.
                { borderColor: theme.borderMuted, backgroundColor: theme.background },
              ]}
            >
              <ThemedText type="defaultBold">{t('trip.remindMe')}</ThemedText>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    alignItems: 'flex-start',
  },
  backChip: {
    borderRadius: 999,
    padding: Spacing.one,
  },
  backButton: {
    padding: Spacing.one,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
  footer: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  startButton: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
  // Cancelling is not the thing to reach for, so it reads as a border rather
  // than as the filled pill Start is.
  outlineButton: {
    borderWidth: 1.5,
  },
  reminderNote: {
    paddingTop: Spacing.two,
    textAlign: 'center',
  },
  unavailable: {
    flex: 1,
    padding: Spacing.three,
    gap: Spacing.four,
  },
});
