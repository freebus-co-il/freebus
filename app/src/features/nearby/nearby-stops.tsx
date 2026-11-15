import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useNearbyStops } from '@/api/stops';
import type { NearbyStop } from '@/api/types';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { Banner, ListRow, ListSection, SkeletonRow, Text } from '@/design-system';
import { useSearch } from '@/features/search/search-context';
import { useNow } from '@/hooks/use-now';
import { formatDistanceMeters } from '@/lib/format';

import { DEPARTURES_PER_STATION, DepartureLine } from './departure-line';
import { ClosestStationMap, ClosestStationMapPlaceholder } from './nearby-stops-map';

/** How many placeholder rows stand in for the list while the fix and the
 *  stops are on their way -- about what the section shows once loaded. */
const SKELETON_ROWS = 3;

/** Always renders its station, whatever the departures came back as -- an
 *  empty board is a real answer here, not a reason to hide the stop. A
 *  Saturday in Israel has no bus service at all, so hiding empty stations
 *  emptied this whole section and made it look broken rather than accurate.
 *  No service simply shows no departures: the row's name and distance already
 *  say the stop is there, and a per-row "no buses" line said the same thing
 *  five times over on a day the whole country isn't running. */
function StationRow(
  { stop, lang, showLive, now }:
  { stop: NearbyStop; lang: string; showLive: boolean; now: Date },
) {
  const { data } = useStopDepartures(stop.stopId, DEPARTURES_PER_STATION, lang);
  const departures = data?.departures ?? [];

  return (
    <ListRow
      onPress={() => router.push({ pathname: '/station/[stopId]', params: { stopId: stop.stopId, name: stop.name ?? '' } })}
      leading={<StationIcon kind={stationKindOf(stop)} />}
      title={
        <Text variant="callout" emphasized numberOfLines={1}>
          {stop.name ?? stop.stopId}
        </Text>
      }
      subtitle={
        departures.length > 0
          ? <DepartureLine departures={departures} showLive={showLive} now={now} />
          : undefined
      }
      trailing={
        <Text variant="footnote" numeric color="textSecondary">
          {formatDistanceMeters(stop.distanceMeters)}
        </Text>
      }
      accessory="chevron"
      // Distance and chevron on the name's line, so the departures under it
      // run the full width of the row.
      trailingAlign="title"
    />
  );
}

/** Home screen section listing the closest stops to the device's current
 *  GPS fix, each with its next few departures as small route+ETA entries.
 *  Deliberately reads `originState` (the raw GPS resolution), not
 *  `useSearch().origin` -- the latter can be a manual override (a saved
 *  location, a picked stop) meant for trip planning, not "what's near me
 *  right now". Titled from the first frame, with skeleton rows while the fix
 *  is on its way and the reason when it failed -- this section is most of the
 *  home screen, and hiding it until a fix arrived is what made the screen
 *  read as blank. There is still no permission prompt of its own: a denied
 *  permission only says where to turn it on, and "Try again" is offered only
 *  for a fix that might still come.
 *
 *  A grouped `ListSection` that draws NO horizontal inset of its own: the
 *  screen that hosts it insets it by `Layout.pageInset`, like every group.
 *
 *  Lays its stations out in a plain column and does NOT scroll them itself:
 *  the home screen scrolls as one page, and a list that scrolled inside that
 *  page would trap the gesture and cut itself off at whatever height was
 *  left over. */
export function NearbyStops({ limit, footer, featureClosest = false }: {
  /** How many stops. The home screen keeps the API's default handful; the
   *  Stations tab shows more, because there nearby IS the browse list. */
  limit?: number;
  /** A note under the list (where to look for anything further away). */
  footer?: string;
  /** Draws the closest station as a map at the top of the group instead of
   *  as a row, and lists the rest under it -- so `limit` is the map's station
   *  plus the rows. The home screen's hero. */
  featureClosest?: boolean;
} = {}) {
  const { t, i18n } = useTranslation();
  const showLive = useRealtimeAvailable();
  // One clock for every entry in the section -- see the station board's own
  // comment for why the countdowns cannot be left to re-render on their own.
  const now = useNow();
  const { originState, retryOrigin } = useSearch();
  const here = originState.status === 'success' && originState.place.kind === 'coordinate'
    ? originState.place
    : null;

  const { data, isLoading } = useNearbyStops(here && { lat: here.lat, lon: here.lon }, i18n.language, limit);
  const stops = data?.stops ?? [];
  const withMap = featureClosest;

  if (originState.status === 'error') {
    const denied = originState.message === 'location_permission_denied';
    return (
      <View>
        <ListSection title={t('nearby.title')} />
        <Banner
          icon="currentLocation"
          title={t(denied ? 'search.locationPermissionDenied' : 'search.locationUnavailable')}
          action={denied ? undefined : { label: t('search.retryLocation'), onPress: retryOrigin, icon: 'refresh' }}
        />
      </View>
    );
  }

  if (here === null || isLoading) {
    return (
      <ListSection
        title={withMap ? undefined : t('nearby.title')}
        media={withMap ? <ClosestStationMapPlaceholder /> : undefined}
      >
        {Array.from({ length: SKELETON_ROWS }, (_, index) => <SkeletonRow key={index} />)}
      </ListSection>
    );
  }

  if (stops.length === 0) {
    return (
      <ListSection title={t('nearby.title')}>
        <ListRow title={<Text variant="subheadline" color="textSecondary">{t('nearby.empty')}</Text>} />
      </ListSection>
    );
  }

  return (
    <ListSection
      // With the map, its panel carries the title.
      title={withMap ? undefined : t('nearby.title')}
      media={withMap ? <ClosestStationMap here={here} stops={stops} lang={i18n.language} /> : undefined}
      footer={footer}
    >
      {(withMap ? stops.slice(1) : stops).map((stop) => (
        <StationRow
          key={stop.stopId}
          stop={stop}
          lang={i18n.language}
          showLive={showLive}
          now={now}
        />
      ))}
    </ListSection>
  );
}
