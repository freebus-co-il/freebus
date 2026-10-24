import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { MapSchemeScope } from '@/components/map-scheme-scope';
import { useRouteShapes } from '@/api/lines';
import type { TransitLeg } from '@/api/types';
import { useVehicles } from '@/api/vehicles';
import { Button, EmptyState, IconButton, Layout, MapStyle, Space, useColors } from '@/design-system';
import { canSwitchLine } from '@/features/journey/journey-card-model';
import { useJourney } from '@/features/journey/journey-context';
import { LineSwitchSheet } from '@/features/journey/line-switch-sheet';
import { LiveBusCard } from '@/features/journey/live-bus-card';
import { NavigationBanner } from '@/features/journey/navigation/navigation-banner';
import { usePreferences } from '@/features/preferences/preferences-context';
import { navigationCamera } from '@/features/journey/navigation/navigation-camera';
import { useCompassHeading } from '@/features/journey/navigation/use-compass-heading';
import { useNavigationFix } from '@/features/journey/navigation/use-navigation-fix';
import { useWalkReroute } from '@/features/journey/navigation/use-walk-reroute';
import { walkGuidance } from '@/features/journey/navigation/walk-guidance';
import { backboneAhead } from '@/features/journey/replan/backbone';
import { EtaHeader } from '@/features/journey/sheet/eta-header';
import { FloatingSheet } from '@/features/journey/sheet/floating-sheet';
import { JourneyMenu } from '@/features/journey/sheet/journey-menu';
import {
  AlightView,
  ArrivingView,
  OfferView,
  RecalculatingView,
  RidingView,
  WaitingView,
  WalkingView,
} from '@/features/journey/sheet/phase-views';
import { SwitchToast } from '@/features/journey/sheet/switch-toast';
import { TripMap, type LineShape } from '@/features/results/trip-map';
import { useAppActive } from '@/hooks/use-app-active';
import { useNow } from '@/hooks/use-now';
import { countEvent } from '@/lib/analytics';
import { routeColor } from '@/lib/route-color';

/** The back button's height below the safe area, plus breathing room: the
 *  part of the map's top it covers before the header has been measured. */
const BACK_CHIP_CLEARANCE = 64;

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
 *
 * Painted in the map's scheme (`MapSchemeScope`): it sits on the map.
 */
export default function JourneyScreen() {
  return (
    <MapSchemeScope screen>
      <JourneyScreenContent />
    </MapSchemeScope>
  );
}

function JourneyScreenContent() {
  const { t } = useTranslation();
  const colors = useColors();
  const now = useNow();
  const insets = useSafeAreaInsets();
  const { journey, state, rail, hydrated, position, live: liveJourney, acknowledgeAlight, chooseLine, end, replan } = useJourney();
  const { alertSettings } = usePreferences();

  const [sheetHeight, setSheetHeight] = useState(0);
  // The header grows with the navigation banner, so its real height -- not a
  // fixed allowance for the back chip -- is what the map keeps clear.
  const [headerHeight, setHeaderHeight] = useState(0);
  // The back chip floats over the map's top edge and the cards over its
  // bottom, so the route frames between them. Memoized: the map re-fits
  // whenever this changes identity.
  const mapEdgePadding = useMemo(
    () => ({
      top: headerHeight > 0 ? headerHeight + Space.lg : insets.top + BACK_CHIP_CLEARANCE,
      right: MapStyle.edgePadding,
      bottom: sheetHeight + Space.lg,
      left: MapStyle.edgePadding,
    }),
    [headerHeight, insets.top, sheetHeight],
  );

  // The leg index whose line switcher is open, or null. By index rather than
  // by leg, so a `chooseLine` that swaps the leg underneath cannot leave the
  // sheet holding the run the rider just moved off.
  const [switchingLegIndex, setSwitchingLegIndex] = useState<number | null>(null);

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
  const appActive = useAppActive();
  const [cameraPaused, setCameraPaused] = useState(false);
  const walkFix = useNavigationFix(walkLeg !== null && appActive);
  const riderFix = walkFix ?? position;
  const compassHeading = useCompassHeading(walkLeg !== null && !cameraPaused && appActive);
  const walkRoute = useWalkReroute({ legIndex: state?.legIndex ?? -1, leg: walkLeg, fix: riderFix });
  const guidance = walkRoute ? walkGuidance(walkRoute.path, walkRoute.steps, riderFix) : null;
  const currentVehicle = currentLeg?.type === 'transit'
    ? live?.vehicles.find((vehicle) => vehicle.tripId === currentLeg.tripId) ?? null
    : null;
  const camera = journey && state && guiding
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

  // Glass over the map; on the empty page below, with no map to float over,
  // the same control filled.
  const back = (variant: 'glass' | 'filled') => (
    <IconButton icon="chevronBack" variant={variant} accessibilityLabel={t('common.back')} onPress={dismiss} />
  );

  if (!journey || !state || !rail) {
    // Reached by ending a journey, by arriving (the context ends it for the
    // rider), and by deep-linking here with nothing running. Says so rather
    // than rendering a journey-shaped screen with nothing in it.
    return (
      <View style={[styles.container, { backgroundColor: colors.bgPlain }]}>
        <SafeAreaView style={styles.empty}>
          {back('filled')}
          {/* Nothing at all until the stored journey has been read back: a
              "no journey" line that flashes and is then replaced is a lie the
              rider has time to believe. */}
          {hydrated && <EmptyState icon="navigate" title={t('journey.none')} />}
        </SafeAreaView>
      </View>
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
          countEvent('journey_cancelled');
          void end();
          dismiss();
        },
      },
    ]);
  }


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

  const switchLine = state.leg !== null && canSwitchLine(state, state.legIndex)
    ? () => setSwitchingLegIndex(state.legIndex)
    : null;
  const nowMs = now.getTime();
  const body = (() => {
    switch (state.phase) {
      case 'off-plan':
        return replan.offer ? null : <RecalculatingView stuck={replan.stuck && replan.status !== 'recalculating'} />;
      case 'walking-to-stop':
      case 'transferring':
        return <WalkingView state={state} itinerary={journey.itinerary} position={position} transfer={state.phase === 'transferring'} />;
      case 'waiting':
        return state.leg && (
          <WaitingView
            state={state}
            leg={state.leg}
            candidates={replan.candidates}
            nowMs={nowMs}
            backbone={backboneAhead(journey.backbone ?? null, journey.itinerary.legs.slice(0, state.legIndex))}
            onSwitchLine={switchLine}
          />
        );
      case 'riding':
        return state.leg && <RidingView state={state} leg={state.leg} onSwitchLine={switchLine} />;
      case 'alight-soon':
        return state.leg && (
          <AlightView
            state={state}
            itinerary={journey.itinerary}
            leg={state.leg}
            nowMs={nowMs}
            canSilence={alertSettings.repeatUntilAcknowledged}
            onSilence={acknowledgeAlight}
          />
        );
      case 'arriving':
      case 'arrived':
        return <ArrivingView state={state} destinationLabel={journey.destinationLabel} />;
    }
  })();

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPlain }]}>
      <TripMap
        itinerary={journey.itinerary}
        focusLegIndex={null}
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
          {back('glass')}
          <View style={styles.bannerSlot} pointerEvents="box-none">
            <NavigationBanner
              itinerary={journey.itinerary}
              state={state}
              guidance={guidance}
              rerouting={walkRoute?.rerouting ?? false}
              destinationLabel={journey.destinationLabel}
            />
          </View>
          <JourneyMenu onEnd={confirmEnd} />
        </View>
        <SwitchToast change={replan.lastSwitch} />
        {camera !== null && cameraPaused && (
          <Button
            variant="glass"
            size="md"
            icon="currentLocation"
            label={t('journey.nav.recenter')}
            onPress={() => setCameraPaused(false)}
            style={styles.recenter}
          />
        )}
      </SafeAreaView>

      <FloatingSheet onHeightChange={setSheetHeight}>
        <EtaHeader arrivalTime={state.arrivalTime} live={state.timeSource === 'live'} />
        {/* A different kind of trip, offered because the rider's own way broke
            -- in whatever phase that was found, above what the phase says. */}
        {replan.offer && (
          <OfferView offer={replan.offer} onAccept={replan.acceptOffer} onKeep={replan.dismissOffer} />
        )}
        {body}
      </FloatingSheet>

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
    gap: Space.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
  },
  bannerSlot: {
    flex: 1,
  },
  // Only while the rider has moved the map off where following would put it.
  recenter: {
    alignSelf: 'flex-end',
  },
  empty: {
    flex: 1,
    padding: Layout.pageInset,
    gap: Space.xxl,
  },
});
