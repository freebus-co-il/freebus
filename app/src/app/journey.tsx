import { IconCurrentLocation } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRouteShapes } from '@/api/lines';
import type { TransitLeg } from '@/api/types';
import { useVehicles } from '@/api/vehicles';
import { IconBack } from '@/components/directional-icon';
import { SnapCarousel, type SnapCarouselHandle } from '@/components/snap-carousel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { canSwitchLine } from '@/features/journey/journey-card-model';
import { useJourney } from '@/features/journey/journey-context';
import { JourneyLegCard } from '@/features/journey/journey-leg-card';
import { LineSwitchSheet } from '@/features/journey/line-switch-sheet';
import { LiveBusCard } from '@/features/journey/live-bus-card';
import { NavigationBanner } from '@/features/journey/navigation/navigation-banner';
import { navigationCamera } from '@/features/journey/navigation/navigation-camera';
import { useCompassHeading } from '@/features/journey/navigation/use-compass-heading';
import { useNavigationFix } from '@/features/journey/navigation/use-navigation-fix';
import { useWalkReroute } from '@/features/journey/navigation/use-walk-reroute';
import { walkGuidance } from '@/features/journey/navigation/walk-guidance';
import { OffPlanCard } from '@/features/journey/off-plan-card';
import { TripMap, type LineShape } from '@/features/results/trip-map';
import { buildStepCards, cardFocusLegIndex, journeyCardIndex, type StepCard } from '@/features/trip/step-cards';
import { useAppActive } from '@/hooks/use-app-active';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { routeColor } from '@/lib/route-color';

/** The back chip's height below the safe area, plus breathing room: the part
 *  of the map's top it covers. */
const BACK_CHIP_CLEARANCE = 64;
/** `TripMap`'s own default for the edges nothing floats over. */
const MAP_EDGE_PADDING = 50;

/** How long a swipe of the rider's own holds the carousel where they put it.
 *  A rider reading ahead to their transfer should not have the card pulled
 *  out from under them the moment the walk to the stop ends. */
const MANUAL_BROWSE_HOLD_MS = 20_000;

/**
 * The running journey, full screen.
 *
 * The trip screen's twin -- the same map, the same cards -- so committing to
 * a journey changes what the screen says without changing where the rider has
 * to look for it. The first card is what is happening now across the whole
 * journey; the carousel opens on, and follows, the leg the rider is on.
 *
 * The itinerary comes from the journey context rather than the plan cache: a
 * running journey outlives the query that found it, and re-deriving it from a
 * cache that may have been refetched is exactly the failure `trip.tsx` renders
 * "this trip isn't available any more" for.
 */
export default function JourneyScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const now = useNow();
  const insets = useSafeAreaInsets();
  const { journey, state, rail, hydrated, position, live: liveJourney, acknowledgeAlight, chooseLine, end } = useJourney();

  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  // The header grows with the navigation banner, so its real height -- not a
  // fixed allowance for the back chip -- is what the map keeps clear.
  const [headerHeight, setHeaderHeight] = useState(0);
  // The back chip floats over the map's top edge and the cards over its
  // bottom, so the route frames between them. Memoized: the map re-fits
  // whenever this changes identity.
  const mapEdgePadding = useMemo(
    () => ({
      top: headerHeight > 0 ? headerHeight + Spacing.three : insets.top + BACK_CHIP_CLEARANCE,
      right: MAP_EDGE_PADDING,
      bottom: bottomBarHeight + Spacing.three,
      left: MAP_EDGE_PADDING,
    }),
    [headerHeight, insets.top, bottomBarHeight],
  );

  // The running journey has no overview card. Its two facts -- the rail and
  // the arrival -- are on the strip row of every leg card, so a card whose
  // whole job was to repeat the hero sentence one swipe away is exactly the
  // duplication this screen was built to remove. `journeyCardIndex` and
  // `cardFocusLegIndex` both test `kind`, never index 0, so nothing counts.
  const cards = useMemo<StepCard[]>(() => {
    if (!journey) return [];
    // Off plan is the one exception, and it is not optional: `journeyCardIndex`
    // falls back to index 0 for this phase, and with the leg cards filtered
    // out below, index 0 would be a REAL leg -- so the map's `focusLegIndex`
    // (via `cardFocusLegIndex`) would zoom to leg 0 and dim every other leg,
    // regardless of which leg the rider actually fell off. A single overview
    // entry restores every invariant at once: `journeyCardIndex` returns 0
    // because that is genuinely the only card, `cardFocusLegIndex` sees
    // `kind: 'overview'` and hands the map `null` (frame the whole journey,
    // undimmed), and `renderCard` already renders `OffPlanCard` for it -- one
    // card, one thing to do, instead of N identical `OffPlanCard`s to swipe
    // between.
    if (state?.phase === 'off-plan') return [{ kind: 'overview' }];
    return buildStepCards(journey.itinerary).filter((card) => card.kind !== 'overview');
  }, [journey, state?.phase]);
  const followIndex = state ? journeyCardIndex(cards, state) : 0;
  const [activeIndex, setActiveIndex] = useState(followIndex);
  const carouselRef = useRef<SnapCarouselHandle>(null);
  const alighting = state?.phase === 'alight-soon';
  const lastSwipeAt = useRef(0);
  // Bumped by each swipe of the rider's own, so the follow effect below
  // re-arms its hold from the latest one.
  const [swipeCount, setSwipeCount] = useState(0);
  // The leg index whose line switcher is open, or null. By index rather than
  // by leg, so a `chooseLine` that swaps the leg underneath cannot leave the
  // sheet holding the run the rider just moved off.
  const [switchingLegIndex, setSwitchingLegIndex] = useState<number | null>(null);

  // Follow the journey onto its next leg -- unless the rider is browsing, in
  // which case they keep the card they chose until the hold since their last
  // swipe is up, and are then brought back to the leg they are on. A leg that
  // changed during the hold is caught up with when it ends, not skipped. The
  // get-off moment overrides the hold: it is the one card that must be on
  // screen when the alarm sounds.
  useEffect(() => {
    const wait = alighting ? 0 : Math.max(0, MANUAL_BROWSE_HOLD_MS - (Date.now() - lastSwipeAt.current));
    if (wait === 0) {
      carouselRef.current?.scrollToIndex(followIndex);
      return;
    }
    const timer = setTimeout(() => carouselRef.current?.scrollToIndex(followIndex), wait);
    return () => clearTimeout(timer);
  }, [followIndex, alighting, swipeCount]);

  // Every transit leg, not just the one being ridden: the rider watching for
  // their connection is watching this map too, and the whole chain is well
  // inside the endpoint's own 12-trip bound (`/plan` caps a journey at 7
  // legs). Declared here, above the early return below, because the poll it
  // feeds is a hook and hooks cannot be conditional.
  const transitLegs = useMemo(
    () => (journey?.itinerary.legs ?? []).filter((leg): leg is TransitLeg => leg.type === 'transit'),
    [journey],
  );
  const tripIds = useMemo(() => transitLegs.map((leg) => leg.tripId), [transitLegs]);
  // A bus is listed only while its own report is fresh: on a keyless feed the
  // server drops any over five minutes old, so a lagging operator's buses are
  // simply absent rather than drawn where they were a quarter of an hour ago.
  const { data: live } = useVehicles(tripIds);
  // Each bus counts down to the rider's stop on it by the journey's own live
  // check -- fresher than anything the itinerary was planned with.
  const vehiclePredictions = useMemo(
    () => new Map((liveJourney?.legs ?? []).map((leg) => [
      leg.legIndex, { departure: leg.predictedDeparture, arrival: leg.predictedArrival },
    ] as const)),
    [liveJourney],
  );

  // --- Navigation ---------------------------------------------------------
  // The map behaves as navigation while the card on screen is the step the
  // rider is on: it follows them, turned to where they are headed, under a
  // banner saying what to do next. Any other card frames its own leg, as the
  // trip screen does, and a finger on the map pauses following until the rider
  // asks for it back.
  const guiding = state !== null && state.phase !== 'off-plan' && state.phase !== 'arrived';
  const currentLeg = journey && state ? journey.itinerary.legs[state.legIndex] : undefined;
  const walkLeg = guiding && currentLeg?.type === 'walk' ? currentLeg : null;
  const onCurrentCard = activeIndex === followIndex;
  const appActive = useAppActive();
  const [cameraPaused, setCameraPaused] = useState(false);
  const walkFix = useNavigationFix(walkLeg !== null && appActive);
  const riderFix = walkFix ?? position;
  const compassHeading = useCompassHeading(walkLeg !== null && onCurrentCard && !cameraPaused && appActive);
  const walkRoute = useWalkReroute({ legIndex: state?.legIndex ?? -1, leg: walkLeg, fix: riderFix });
  const guidance = walkRoute ? walkGuidance(walkRoute.path, walkRoute.steps, riderFix) : null;
  const currentVehicle = currentLeg?.type === 'transit'
    ? live?.vehicles.find((vehicle) => vehicle.tripId === currentLeg.tripId) ?? null
    : null;
  const camera = journey && state && guiding && onCurrentCard
    ? navigationCamera({
        itinerary: journey.itinerary,
        state,
        fix: riderFix,
        now,
        compassHeading,
        bus: currentVehicle ? { lat: currentVehicle.lat, lon: currentVehicle.lon } : null,
        walkGeometry: walkRoute?.reroutedGeometry ?? null,
      })
    : null;

  // Each line's whole path, faded under the legs, so the rider can see where
  // their bus is coming from and where it carries on to. Once per line and
  // direction; an onboard plan's leg can carry no route id to ask about.
  const shapeLegs = useMemo(() => {
    const seen = new Set<string>();
    return transitLegs.filter((leg) => {
      const key = `${leg.route.id}:${leg.directionId}`;
      if (leg.route.id === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [transitLegs]);
  const shapeRequests = useMemo(
    () => shapeLegs.map((leg) => ({ routeId: leg.route.id, directionId: leg.directionId })),
    [shapeLegs],
  );
  const shapes = useRouteShapes(shapeRequests);
  const lineShapes = useMemo<LineShape[]>(() => shapeLegs.flatMap((leg, index) => {
    const shape = shapes[index];
    // A path the feed never published is a straight line between stops; as a
    // backdrop it would claim roads the bus never drives.
    if (!shape || shape.geometryFallback || shape.geometry.coordinates.length < 2) return [];
    return [{
      key: `${leg.route.id}:${leg.directionId}`,
      color: routeColor(leg.route),
      coordinates: shape.geometry.coordinates.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
    }];
  }), [shapeLegs, shapes]);

  // The bus the rider tapped. Kept by trip id rather than by vehicle, so the
  // card stays open -- and says so -- when that bus drops out of the feed.
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const selectedLeg = transitLegs.find((leg) => leg.tripId === selectedTripId) ?? null;

  function dismiss() {
    // A cold launch straight into a running journey has no history to pop --
    // the spec's "the app launches into it" -- so the chevron would be a dead
    // control on the one launch this screen was designed for.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  const back = (
    <Pressable accessibilityRole="button" onPress={dismiss} style={styles.backButton} hitSlop={Spacing.three}>
      <IconBack size={24} color={theme.text} />
    </Pressable>
  );

  if (!journey || !state || !rail) {
    // Reached by ending a journey, by arriving (the context ends it for the
    // rider), and by deep-linking here with nothing running. Says so rather
    // than rendering a journey-shaped screen with nothing in it.
    return (
      <ThemedView type="background" style={styles.container}>
        <SafeAreaView style={styles.empty}>
          {back}
          {/* Nothing at all until the stored journey has been read back: a
              "no journey" line that flashes and is then replaced is a lie the
              rider has time to believe. */}
          {hydrated && <ThemedText type="default">{t('journey.none')}</ThemedText>}
        </SafeAreaView>
      </ThemedView>
    );
  }

  function confirmEnd() {
    // Ending is deliberate, never a stray tap -- so the button itself does
    // nothing but ask. Dismissing alongside `end` puts the rider back where
    // they expanded this from; the provider lives above the navigator, so the
    // teardown finishes whether or not this screen is still mounted.
    Alert.alert(t('journey.endConfirm'), undefined, [
      { text: t('journey.keepGoing'), style: 'cancel' },
      {
        text: t('journey.end'),
        style: 'destructive',
        onPress: () => {
          void end();
          dismiss();
        },
      },
    ]);
  }

  const offPlan = state.phase === 'off-plan';

  // The open sheet's leg, re-asked of the same predicate the card's trigger
  // uses on EVERY render rather than captured when the sheet opened: the
  // machine re-resolves every five seconds, and `chooseLine` rewrites whichever
  // leg it is handed -- including one the rider has already ridden. So a ride
  // that goes behind them, or enters the get-off window, takes its sheet down
  // with it instead of leaving a live list of runs over a leg that can no
  // longer be switched.
  //
  // The index is dropped here at render time, not in an effect: the phase can
  // come BACK -- `alight-soon` returns to `riding` the moment the rider taps
  // "Got it" -- and an intent still sitting in state would re-open, unasked, a
  // sheet they had already finished with. Adjusting state during render is
  // React's own answer for this (and what `line-switch-sheet.tsx` does with
  // its remembered leg); an effect for it is a cascading render.
  const switchingLeg =
    switchingLegIndex !== null && canSwitchLine(state, switchingLegIndex)
      ? journey.itinerary.legs[switchingLegIndex]
      : undefined;
  if (switchingLegIndex !== null && switchingLeg === undefined) setSwitchingLegIndex(null);

  const renderCard = (card: StepCard) => {
    // The off-plan card stands in place of whatever card is showing: the legs
    // after the one the rider fell off are no longer the journey.
    if (offPlan) return <OffPlanCard state={state} />;
    // Unreachable: the running journey's card list never carries an
    // `overview` entry outside the off-plan branch above, which already
    // returned. Returning null rather than an empty `StepCardFrame` means a
    // future change that DOES reach this can't render a blank bordered card.
    if (card.kind === 'overview') return null;
    return (
      <JourneyLegCard
        card={card}
        state={state}
        itinerary={journey.itinerary}
        destinationLabel={journey.destinationLabel}
        // Faded rather than dropped: a rider three legs in still looks back to
        // check they did the earlier part right.
        done={card.legIndex < state.legIndex}
        current={card.legIndex === state.legIndex}
        onSwitchLine={card.kind === 'ride' ? () => setSwitchingLegIndex(card.legIndex) : undefined}
      />
    );
  };

  return (
    <ThemedView type="background" style={styles.container}>
      <TripMap
        itinerary={journey.itinerary}
        focusLegIndex={cardFocusLegIndex(cards[activeIndex])}
        vehicles={live?.vehicles}
        vehiclePredictions={vehiclePredictions}
        vehiclesTowardsAlighting
        lineShapes={lineShapes}
        onVehiclePress={(tripId) => setSelectedTripId((current) => (current === tripId ? null : tripId))}
        onMapPress={() => setSelectedTripId(null)}
        selectedVehicleTripId={selectedLeg?.tripId ?? null}
        vehicleCard={selectedLeg && (
          <LiveBusCard
            leg={selectedLeg}
            vehicle={live?.vehicles.find((vehicle) => vehicle.tripId === selectedLeg.tripId) ?? null}
            now={now}
            onClose={() => setSelectedTripId(null)}
            onOpenRoute={() => router.push({
              pathname: '/run/[tripId]',
              params: selectedLeg.from.stop.stopId
                ? { tripId: selectedLeg.tripId, fromStopId: selectedLeg.from.stop.stopId }
                : { tripId: selectedLeg.tripId },
            })}
          />
        )}
        edgePadding={mapEdgePadding}
        navigationCamera={camera}
        cameraPaused={cameraPaused}
        onUserGesture={() => {
          if (camera !== null) setCameraPaused(true);
        }}
        walkOverride={walkRoute?.reroutedGeometry
          ? { legIndex: state.legIndex, geometry: walkRoute.reroutedGeometry }
          : null}
      />

      <SafeAreaView
        style={styles.header}
        edges={['top']}
        pointerEvents="box-none"
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      >
        <View style={styles.headerRow} pointerEvents="box-none">
          <ThemedView type="background" style={styles.backChip}>
            {back}
          </ThemedView>
          <View style={styles.bannerSlot} pointerEvents="box-none">
            <NavigationBanner
              itinerary={journey.itinerary}
              state={state}
              guidance={guidance}
              rerouting={walkRoute?.rerouting ?? false}
              destinationLabel={journey.destinationLabel}
            />
          </View>
        </View>
        {camera !== null && cameraPaused && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setCameraPaused(false)}
            style={[styles.recenter, { backgroundColor: theme.background, borderColor: theme.borderMuted }]}
          >
            <IconCurrentLocation size={20} color={theme.text} />
            <ThemedText type="smallBold">{t('journey.nav.recenter')}</ThemedText>
          </Pressable>
        )}
      </SafeAreaView>

      <SafeAreaView
        style={styles.bottomBar}
        edges={['bottom']}
        pointerEvents="box-none"
        onLayout={(event) => setBottomBarHeight(event.nativeEvent.layout.height)}
      >
        <SnapCarousel
          ref={carouselRef}
          data={cards}
          keyExtractor={(card) => (card.kind === 'overview' ? 'overview' : `leg-${card.legIndex}`)}
          initialIndex={followIndex}
          onActiveIndexChange={setActiveIndex}
          onUserSwipe={() => {
            lastSwipeAt.current = Date.now();
            setSwipeCount((count) => count + 1);
          }}
          renderItem={renderCard}
        />

        <View style={styles.footer}>
          {/* One button at a time, and the phase picks it. While the alarm is
              sounding the only thing a rider wants is to silence it, and asking
              them to pick their action out of two -- one of which throws the
              journey away -- is how that goes wrong at the exact moment it must
              not. Ending stays one phase away, and this window is ~90 seconds. */}
          {alighting ? (
            <Pressable
              accessibilityRole="button"
              onPress={acknowledgeAlight}
              style={[styles.ackButton, { backgroundColor: theme.text }]}
            >
              <ThemedText type="defaultBold" themeColor="background">
                {t('journey.alert.gotIt')}
              </ThemedText>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={confirmEnd}
              style={[styles.endButton, { backgroundColor: theme.background }]}
            >
              <ThemedText type="defaultBold" themeColor="danger">
                {t('journey.end')}
              </ThemedText>
            </Pressable>
          )}
        </View>
      </SafeAreaView>

      <LineSwitchSheet
        leg={switchingLeg?.type === 'transit' ? switchingLeg : null}
        onChoose={(tripId) => {
          // Checked again here rather than trusted from the open sheet: the
          // tap is handled a frame later than the render that drew the row.
          if (switchingLegIndex !== null && canSwitchLine(state, switchingLegIndex)) {
            void chooseLine(switchingLegIndex, tripId);
          }
        }}
        onClose={() => setSwitchingLegIndex(null)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  ackButton: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
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
    gap: Spacing.two,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  bannerSlot: {
    flex: 1,
  },
  // Only while the rider has moved the map off where following would put it.
  recenter: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
    borderWidth: 1,
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
  },
  // A compact, centred text button, not a full-width pill -- ending is the
  // destructive option and the one thing a rider never came to this screen
  // to do; `Got it` above is the one that has to be hittable without
  // looking. It still needs a `background` backing: this sits directly over
  // live map tiles, and `danger`-coloured text with nothing behind it can
  // lose contrast against whatever the map is showing underneath. The pill
  // radius and horizontal padding read it as a chip rather than restoring
  // the old full-width bordered button.
  endButton: {
    alignSelf: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
  empty: {
    flex: 1,
    padding: Spacing.three,
    gap: Spacing.four,
  },
});
