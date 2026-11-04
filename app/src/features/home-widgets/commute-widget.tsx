import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGet } from '@/api/client';
import { usePlanTrip } from '@/api/plan';
import type { PlanResponse } from '@/api/types';
import { fetchWalk } from '@/api/walk';
import { MapSchemeScope } from '@/components/map-scheme-scope';
import { Banner } from '@/design-system';
import { useCustomJourneys } from '@/features/custom-journeys/custom-journeys-context';
import { planCustomJourney } from '@/features/custom-journeys/plan-custom-journey';
import { reversedPoints, type CustomJourney } from '@/features/custom-journeys/types';
import { useStartCustomJourney } from '@/features/custom-journeys/use-start-custom-journey';
import { usePreferences } from '@/features/preferences/preferences-context';
import { LOCATION_ICON_NAMES } from '@/features/saved-locations/location-icons';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { useSearch } from '@/features/search/search-context';
import { NearbySuggestion } from '@/features/smart-suggestion/nearby-suggestion';
import { SmartSuggestion, TripPreviewCard, TripPreviewLoading } from '@/features/smart-suggestion/smart-suggestion';
import { placeToQueryValue, type SelectedPlace } from '@/lib/place';

import { closestStartIndex, placeDestinationIndex, type CommuteSource } from './commute-source';

/** A journey preview is re-planned at most this often while home stays open. */
const JOURNEY_PREVIEW_STALE_MS = 60_000;
/** The fix is rounded to about 100 m for the preview's cache key, so GPS
 *  jitter while the rider stands still does not re-plan the whole journey. */
const FIX_KEY_DECIMALS = 3;

/** The id the reversed way back runs under. Never stored as a journey. */
const REVERSED_SUFFIX = '~back';

/**
 * The commute card, planned from whichever source the rider picked in its
 * options. Without the source set up, it says what is missing and where to
 * fix it rather than vanishing from a page the rider just put it on. With
 * nothing to offer right now, it falls back to the closest station's peek,
 * unless the nearby widget is already on the page.
 */
export function CommuteWidget({ showsNearby, onSelect }: {
  showsNearby: boolean;
  onSelect: (place: SelectedPlace) => void;
}) {
  const { commuteSource } = usePreferences();
  // Map cards are painted in the map's scheme; the set-up banners are page
  // content and stay in the app's.
  const fallback = showsNearby ? null : <MapSchemeScope><NearbySuggestion /></MapSchemeScope>;
  return <CommuteCard source={commuteSource} fallback={fallback} onSelect={onSelect} />;
}

function MapCard(props: Parameters<typeof TripPreviewCard>[0]) {
  return (
    <MapSchemeScope>
      <TripPreviewCard {...props} />
    </MapSchemeScope>
  );
}

function Loading() {
  return (
    <MapSchemeScope>
      <TripPreviewLoading />
    </MapSchemeScope>
  );
}

function CommuteCard({ source, fallback, onSelect }: {
  source: CommuteSource;
  fallback: ReactNode;
  onSelect: (place: SelectedPlace) => void;
}) {
  if (source.kind === 'places') return <PlacesCard source={source} fallback={fallback} onSelect={onSelect} />;
  if (source.kind === 'journeys') return <JourneysCard source={source} fallback={fallback} />;
  return <SmartCard fallback={fallback} onSelect={onSelect} />;
}

/** The rider's raw GPS fix, never a manual origin: see `NearbyStops`. */
function useHere() {
  const { originState } = useSearch();
  return originState.status === 'success' && originState.place.kind === 'coordinate' ? originState.place : null;
}

function SetupBanner({ icon, titleKey, messageKey, actionKey, onPress }: {
  icon: 'home' | 'pin' | 'navigate';
  titleKey: string;
  messageKey: string;
  actionKey: string;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return <Banner icon={icon} title={t(titleKey)} message={t(messageKey)} action={{ label: t(actionKey), onPress }} />;
}

const openOptions = () => router.push('/settings/commute');

function SmartCard({ fallback, onSelect }: { fallback: ReactNode; onSelect: (place: SelectedPlace) => void }) {
  const { locations } = useSavedLocations();
  const home = locations.find((location) => location.id === 'home');
  if (!home?.place) {
    return (
      <SetupBanner
        icon="home"
        titleKey="homeWidgets.commuteSetupTitle"
        messageKey="homeWidgets.commuteSetupMessage"
        actionKey="homeWidgets.commuteSetupAction"
        onPress={() => router.push({ pathname: '/location-picker', params: { field: 'saved-home' } })}
      />
    );
  }
  return <SmartSuggestion onSelect={onSelect} fallback={fallback} />;
}

function PlacesCard({ source, fallback, onSelect }: {
  source: Extract<CommuteSource, { kind: 'places' }>;
  fallback: ReactNode;
  onSelect: (place: SelectedPlace) => void;
}) {
  const { i18n } = useTranslation();
  const { locations } = useSavedLocations();
  const here = useHere();
  const first = locations.find((location) => location.id === source.first && location.place);
  const second = locations.find((location) => location.id === source.second && location.place);
  const pair = first && second && first.id !== second.id ? [first, second] as const : null;
  const target = pair && here ? pair[placeDestinationIndex(here, pair[0].place!, pair[1].place!)] : null;

  // The same query the Home and Work card makes: no time, no vehicle filter.
  const { data, isLoading } = usePlanTrip(
    here && target ? { from: placeToQueryValue(here), to: placeToQueryValue(target.place!), lang: i18n.language } : null,
  );

  if (!pair) {
    return (
      <SetupBanner
        icon="pin"
        titleKey="homeWidgets.placesSetupTitle"
        messageKey="homeWidgets.placesSetupMessage"
        actionKey="homeWidgets.setUp"
        onPress={openOptions}
      />
    );
  }
  if (!target) return fallback;
  if (isLoading) return <Loading />;
  const best = data?.itineraries[0];
  if (!best) return fallback;

  return (
    <MapCard
      itinerary={best}
      icon={LOCATION_ICON_NAMES[target.icon]}
      label={target.label}
      onPress={() => onSelect(target.place!)}
    />
  );
}

function JourneysCard({ source, fallback }: {
  source: Extract<CommuteSource, { kind: 'journeys' }>;
  fallback: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { find, loaded } = useCustomJourneys();
  const { startJourney, startingId } = useStartCustomJourney();
  const here = useHere();

  const there = find(source.there);
  // A way back that was deleted falls back to the reversed journey rather
  // than leaving the card with only one direction.
  const back: CustomJourney | null = there
    ? (source.back !== 'reverse' && find(source.back)) || {
      ...there,
      id: `${there.id}${REVERSED_SUFFIX}`,
      name: t('homeWidgets.wayBackName', { name: there.name }),
      points: reversedPoints(there.points),
    }
    : null;
  const candidates = there && back ? [there, back] : [];
  const chosen = candidates[closestStartIndex(here, candidates.map((journey) => journey.points))] ?? null;

  const fixKey = here ? `${here.lat.toFixed(FIX_KEY_DECIMALS)},${here.lon.toFixed(FIX_KEY_DECIMALS)}` : null;
  const { data, isLoading } = useQuery({
    // The points, not just the id: an edited journey must re-plan, and the
    // reversed one gets fresh point ids every render.
    queryKey: ['commuteJourney', chosen?.id, chosen?.points.map((point) => [placeToQueryValue(point.place), point.via]), fixKey, i18n.language],
    queryFn: () => planCustomJourney({
      points: chosen!.points,
      position: here ? { lat: here.lat, lon: here.lon } : null,
      nowMs: Date.now(),
      lang: i18n.language,
      fetchers: { plan: (query) => apiGet<PlanResponse>('/plan', { ...query }), walk: fetchWalk },
    }),
    enabled: chosen !== null,
    staleTime: JOURNEY_PREVIEW_STALE_MS,
    // A step with no service is an answer ("nothing runs now"), not a blip.
    retry: false,
  });

  if (!loaded) return <Loading />;
  if (!there || !chosen) {
    return (
      <SetupBanner
        icon="navigate"
        titleKey="homeWidgets.journeysSetupTitle"
        messageKey="homeWidgets.journeysSetupMessage"
        actionKey="homeWidgets.setUp"
        onPress={openOptions}
      />
    );
  }
  if (isLoading) return <Loading />;
  if (!data) return fallback;

  return (
    <MapCard
      itinerary={data.itinerary}
      icon="navigate"
      label={chosen.name}
      busy={startingId === chosen.id}
      onPress={() => startJourney(chosen)}
    />
  );
}
