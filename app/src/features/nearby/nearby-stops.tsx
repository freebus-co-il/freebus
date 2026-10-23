import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, StyleSheet, View } from 'react-native';

import { useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useNearbyStops } from '@/api/stops';
import type { Departure, NearbyStop } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { LiveIndicator } from '@/components/live-indicator';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { Banner, ListRow, ListSection, Size, SkeletonRow, Space, Text, useColors, withAlpha } from '@/design-system';
import { useSearch } from '@/features/search/search-context';
import { useNow } from '@/hooks/use-now';
import { departureTime } from '@/lib/departure-time';
import { formatDistanceMeters, formatDurationMinutes } from '@/lib/format';

const DEPARTURES_PER_STATION = 4;
/** How many placeholder rows stand in for the list while the fix and the
 *  stops are on their way -- about what the section shows once loaded. */
const SKELETON_ROWS = 3;

function secondsUntil(iso: string, now: Date): number {
  return Math.max(0, (new Date(iso).getTime() - now.getTime()) / 1000);
}

/** One departure, read as a line of text rather than as an object: the
 *  route badge, then how long until it goes.
 *
 *  Not a capsule: a row of capsules reads as a row of
 *  buttons, and none of these is pressable -- the whole station row is.
 *  The pairing is carried by spacing instead: `Space.xs` inside a
 *  departure against `Space.lg` between them, so each time sits
 *  visibly closer to its own badge than to the next one. */
export function DepartureEntry(
  { departure, showLive, now }: { departure: Departure; showLive: boolean; now: Date },
) {
  const colors = useColors();
  const time = departureTime(departure.departureTime, departure.realtime);
  const live = showLive && time.live;

  return (
    <View style={styles.departure}>
      <LineBadge route={departure.route} size="small" />
      {live && <LiveIndicator color={colors.live} size={Size.icon.xs} />}
      <Text variant="footnote" numeric color={live ? 'live' : 'textSecondary'}>
        {formatDurationMinutes(secondsUntil(time.iso, now))}
      </Text>
    </View>
  );
}

/**
 * The departures for one stop, on ONE line however many there are.
 *
 * Wrapping was what made this section ragged: a stop with four buses grew
 * a second line and shoved the next station down, so a list of five stops
 * had no rhythm to scan. A clipped line keeps every row the same height,
 * and the fade says there is more rather than letting the last departure
 * end in a hard cut.
 *
 * Measured the way `LegTimeline` measures its own overflow -- the last
 * item's position against the container's width, which needs no `isRTL`
 * branch because testing both ends covers both directions.
 */
function DepartureLine({ departures, showLive, now }: {
  departures: Departure[]; showLive: boolean; now: Date;
}) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const [tailStart, setTailStart] = useState(0);
  const [tailWidth, setTailWidth] = useState(0);

  const overflowing = width > 0 && (tailStart < -1 || tailStart + tailWidth > width + 1);
  // The row's own surface at zero alpha rather than `transparent`, which is
  // rgba(0,0,0,0) and smears grey through the middle of the ramp -- same
  // reasoning as `LegTimeline`. `surfaceGroup` because the row sits in a
  // grouped list.
  const fade = [withAlpha(colors.surfaceGroup, 0), colors.surfaceGroup] as const;

  return (
    <View
      style={styles.departureLine}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {departures.map((departure, index) => (
        <View
          key={`${departure.runId}:${departure.departureTime}`}
          style={styles.departureSlot}
          onLayout={
            index === departures.length - 1
              ? (event) => {
                setTailStart(event.nativeEvent.layout.x);
                setTailWidth(event.nativeEvent.layout.width);
              }
              : undefined
          }
        >
          <DepartureEntry departure={departure} showLive={showLive} now={now} />
        </View>
      ))}

      {overflowing && (
        <LinearGradient
          // Reversed under RTL: in Hebrew the line runs right-to-left, so
          // the hidden tail -- and the fade over it -- is at the LEFT edge.
          colors={I18nManager.isRTL ? [fade[1], fade[0]] : [fade[0], fade[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          pointerEvents="none"
          style={styles.departureFade}
        />
      )}
    </View>
  );
}

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
export function NearbyStops({ limit, footer }: {
  /** How many stops. The home screen keeps the API's default handful; the
   *  Stations tab shows more, because there nearby IS the browse list. */
  limit?: number;
  /** A note under the list (where to look for anything further away). */
  footer?: string;
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
      <ListSection title={t('nearby.title')}>
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
    <ListSection title={t('nearby.title')} footer={footer}>
      {stops.map((stop) => (
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

const styles = StyleSheet.create({
  // One line, clipped. `nowrap` is the point: a stop with four buses must
  // not grow a second line and shove the next station down.
  departureLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    gap: Space.lg,
    marginTop: Space.xs,
  },
  // Every departure pinned: an overflowing line pushes its tail past the
  // end edge, it never squeezes the departures to fit.
  departureSlot: {
    flexShrink: 0,
  },
  // Tighter than the gap BETWEEN departures, which is the whole of what
  // binds a time to its own badge now that no capsule does.
  departure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  // `end`, not `right`: the hidden tail is at the writing direction's end,
  // which is the LEFT edge in Hebrew.
  departureFade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    end: 0,
    width: Space.xxxl,
  },
});
