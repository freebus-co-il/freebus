import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { MapSchemeScope } from '@/components/map-scheme-scope';
import { usePlanTrip } from '@/api/plan';
import { EmptyState, IconButton, Layout, MapStyle, Size, Space, useColors } from '@/design-system';
import { FloatingSheet } from '@/features/journey/sheet/floating-sheet';
import { useJourney } from '@/features/journey/journey-context';
import { shouldOfferReminder } from '@/features/journey/leave-reminder';
import { itinerarySignature } from '@/features/results/group-itineraries';
import { TripMap } from '@/features/results/trip-map';
import { useSearch } from '@/features/search/search-context';
import { TripSheetHeader } from '@/features/trip/trip-sheet-header';
import { TripStepsList } from '@/features/trip/trip-steps-list';
import { useVehicles } from '@/api/vehicles';
import { itineraryPredictions } from '@/features/results/vehicle-markers';
import { useNow } from '@/hooks/use-now';
import { formatClockTime } from '@/lib/format';
import { placeLabel } from '@/lib/place';

/** The back button's height below the safe area, plus breathing room: the
 *  part of the map's top it covers. */
const BACK_CHIP_CLEARANCE = Space.sm + Size.control.md + Space.md;

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
 *
 * Painted in the map's scheme (`MapSchemeScope`): it sits on the map.
 */
export default function TripScreen() {
  return (
    <MapSchemeScope screen>
      <TripScreenContent />
    </MapSchemeScope>
  );
}

function TripScreenContent() {
  const { t } = useTranslation();
  const colors = useColors();
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

  // The buses this trip rides, each counting down to the stop the rider would
  // board it at.
  const tripIds = useMemo(
    () => (itinerary?.legs ?? []).flatMap((leg) => (leg.type === 'transit' ? [leg.tripId] : [])),
    [itinerary],
  );
  const { data: live } = useVehicles(tripIds);
  const vehiclePredictions = useMemo(() => itineraryPredictions(itinerary), [itinerary]);
  // The step the rider tapped, for the map to zoom to; null frames the trip.
  const [focusLegIndex, setFocusLegIndex] = useState<number | null>(null);

  // Measured, not guessed: the sheet grows with its content. Memoized, since
  // the map re-fits whenever this changes identity.
  const [sheetHeight, setSheetHeight] = useState(0);
  const mapEdgePadding = useMemo(
    () => ({
      top: insets.top + BACK_CHIP_CLEARANCE,
      right: MapStyle.edgePadding,
      bottom: sheetHeight + Space.lg,
      left: MapStyle.edgePadding,
    }),
    [insets.top, sheetHeight],
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

  const back = (variant: 'glass' | 'filled') => (
    <IconButton icon="chevronBack" variant={variant} accessibilityLabel={t('common.back')} onPress={() => router.back()} />
  );

  if (!itinerary) {
    // Reachable when the plan cache has been dropped or refetched into
    // something that no longer holds this journey -- a stale deep link, or a
    // long enough time away from the app. Says so, rather than rendering an
    // empty timeline that looks like a trip with no steps in it.
    return (
      <View style={[styles.container, { backgroundColor: colors.bgGrouped }]}>
        <SafeAreaView style={styles.unavailable}>
          {back('filled')}
          <EmptyState icon="warning" title={t('trip.unavailable')} />
        </SafeAreaView>
      </View>
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

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPlain }]}>
      {/* No `style`: `TripMap`'s own `flex: 1` fills the screen in flow, which
          is what keeps it draggable (see `results.tsx`). */}
      <TripMap
        itinerary={itinerary}
        focusLegIndex={focusLegIndex}
        edgePadding={mapEdgePadding}
        vehicles={live?.vehicles}
        vehiclePredictions={vehiclePredictions}
      />

      <SafeAreaView style={styles.header} edges={['top']} pointerEvents="box-none">
        {back('glass')}
        {/* The reminder is the second way to use a future trip, so it is a
            corner control, not a second big button: filled once armed, and
            tapping it again takes it back. */}
        {offerReminder && (
          <IconButton
            icon={reminderForThisTrip ? 'bellFill' : 'bell'}
            variant="glass"
            selected={reminderForThisTrip}
            accessibilityLabel={t(reminderForThisTrip ? 'trip.cancelReminder' : 'trip.remindMe')}
            onPress={reminderForThisTrip ? () => void cancelLeaveReminder() : remindMe}
          />
        )}
      </SafeAreaView>

      {/* Start is ALWAYS here, however far off the departure is: setting out
          early is a thing riders do, and the journey then begins on the run
          they can actually catch (see `withEarlierRunAtStart`). */}
      <FloatingSheet onHeightChange={setSheetHeight}>
        <TripSheetHeader
          itinerary={itinerary}
          now={now}
          onStart={beginJourney}
          note={reminderForThisTrip ? t('trip.reminderSet', { time: formatClockTime(itinerary.departureTime) }) : null}
        />
        <TripStepsList itinerary={itinerary} focusLegIndex={focusLegIndex} onFocus={setFocusLegIndex} />
      </FloatingSheet>
    </View>
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
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  unavailable: {
    flex: 1,
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.sm,
  },
});
