import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, I18nManager, Pressable, StyleSheet, View } from 'react-native';

import { useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { useNearbyStops } from '@/api/stops';
import type { Departure, NearbyStop } from '@/api/types';
import { Hairline } from '@/components/hairline';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { LiveIndicator } from '@/components/live-indicator';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useSearch } from '@/features/search/search-context';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { departureTime } from '@/lib/departure-time';
import { formatDistanceMeters, formatDurationMinutes } from '@/lib/format';

const DEPARTURES_PER_STATION = 4;

function secondsUntil(iso: string, now: Date): number {
  return Math.max(0, (new Date(iso).getTime() - now.getTime()) / 1000);
}

/** One departure, read as a line of text rather than as an object: the
 *  route badge, then how long until it goes.
 *
 *  Not a capsule: a row of capsules reads as a row of
 *  buttons, and none of these is pressable -- the whole station row is.
 *  The pairing is carried by spacing instead: `Spacing.one` inside a
 *  departure against `Spacing.three` between them, so each time sits
 *  visibly closer to its own badge than to the next one. */
function DepartureEntry(
  { departure, showLive, now }: { departure: Departure; showLive: boolean; now: Date },
) {
  const theme = useTheme();
  const time = departureTime(departure.departureTime, departure.realtime);
  const live = showLive && time.live;

  return (
    <View style={styles.departure}>
      <LineBadge route={departure.route} size="small" />
      {live && <LiveIndicator color={theme.success} size={10} />}
      <ThemedText
        type="small"
        themeColor={live ? undefined : 'textSecondary'}
        style={live ? { color: theme.success } : undefined}
      >
        {formatDurationMinutes(secondsUntil(time.iso, now))}
      </ThemedText>
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
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [tailStart, setTailStart] = useState(0);
  const [tailWidth, setTailWidth] = useState(0);

  const overflowing = width > 0 && (tailStart < -1 || tailStart + tailWidth > width + 1);
  // `${hex}00` rather than `transparent`, which is rgba(0,0,0,0) and smears
  // grey through the middle of the ramp -- same reasoning as `LegTimeline`.
  const fade = [`${theme.background}00`, theme.background] as const;

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
 *  No service simply shows no pills: the row's name and distance already
 *  say the stop is there, and a per-row "no buses" line said the same thing
 *  five times over on a day the whole country isn't running. */
function StationRow(
  { stop, lang, showLive, now }:
  { stop: NearbyStop; lang: string; showLive: boolean; now: Date },
) {
  const { data } = useStopDepartures(stop.stopId, DEPARTURES_PER_STATION, lang);
  const departures = data?.departures ?? [];

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/station/[stopId]', params: { stopId: stop.stopId, name: stop.name ?? '' } })}
    >
      <View style={styles.stationRow}>
        <StationIcon kind={stationKindOf(stop)} />

        <View style={styles.stationBody}>
          <View style={styles.stationHeader}>
            <ThemedText type="smallBold" numberOfLines={1} style={styles.stationName}>
              {stop.name ?? stop.stopId}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {formatDistanceMeters(stop.distanceMeters)}
            </ThemedText>
          </View>

          {departures.length > 0 && (
            <DepartureLine departures={departures} showLive={showLive} now={now} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** Home screen section listing the closest stops to the device's current
 *  GPS fix, each with its next few departures as small route+ETA chips.
 *  Deliberately reads `originState` (the raw GPS resolution), not
 *  `useSearch().origin` -- the latter can be a manual override (a saved
 *  location, a picked stop) meant for trip planning, not "what's near me
 *  right now". Titled from the first frame, with a loader while the fix is on
 *  its way and the reason when it failed -- this section is most of the home
 *  screen, and hiding it until a fix arrived is what made the screen read as
 *  blank. There is still no permission prompt of its own: a denied permission
 *  only says where to turn it on, and "Try again" is offered only for a fix
 *  that might still come.
 *
 *  Lays its stations out in a plain column and does NOT scroll them itself:
 *  the home screen scrolls as one page, and a list that scrolled inside that
 *  page would trap the gesture and cut itself off at whatever height was
 *  left over. */
export function NearbyStops() {
  const { t, i18n } = useTranslation();
  const showLive = useRealtimeAvailable();
  // One clock for every pill in the section -- see the station board's own
  // comment for why the countdowns cannot be left to re-render on their own.
  const now = useNow();
  const { originState, retryOrigin } = useSearch();
  const here = originState.status === 'success' && originState.place.kind === 'coordinate'
    ? originState.place
    : null;

  const { data, isLoading } = useNearbyStops(here && { lat: here.lat, lon: here.lon }, i18n.language);
  const stops = data?.stops ?? [];

  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {t('nearby.title')}
      </ThemedText>
      {originState.status === 'error' ? (
        originState.message === 'location_permission_denied' ? (
          <ThemedText type="small" themeColor="textSecondary">
            {t('search.locationPermissionDenied')}
          </ThemedText>
        ) : (
          <View style={styles.locationError}>
            <ThemedText type="small" themeColor="textSecondary">
              {t('search.locationUnavailable')}
            </ThemedText>
            <Pressable onPress={retryOrigin} style={styles.retry}>
              <ThemedText type="smallBold">{t('search.retryLocation')}</ThemedText>
            </Pressable>
          </View>
        )
      ) : here === null || isLoading ? (
        <ActivityIndicator style={styles.sectionLoader} />
      ) : stops.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {t('nearby.empty')}
        </ThemedText>
      ) : (
        <View>
          {stops.map((stop, index) => (
            <Fragment key={stop.stopId}>
              {index > 0 && <Hairline />}
              <StationRow
                stop={stop}
                lang={i18n.language}
                showLive={showLive}
                now={now}
              />
            </Fragment>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // No gap under a list heading: the first row's own vertical padding is
  // the space. A gap on top of that padding reads as a bigger break than
  // the one between the rows themselves, which says the heading is not
  // attached to the list it names.
  section: {
    gap: 0,
  },
  sectionLoader: {
    alignSelf: 'flex-start',
  },
  locationError: {
    alignItems: 'flex-start',
  },
  retry: {
    paddingVertical: Spacing.two,
  },
  // A row, not a card: no fill, no radius, and no horizontal padding of its
  // own -- the page already insets this column, and padding here would step
  // the rows in from the hairlines that separate them.
  stationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.four,
  },
  stationBody: {
    flex: 1,
    gap: Spacing.two,
  },
  stationHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  stationName: {
    flex: 1,
  },
  // One line, clipped. `nowrap` is the point: a stop with four buses must
  // not grow a second line and shove the next station down.
  departureLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    gap: Spacing.three,
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
    gap: Spacing.one,
  },
  // `end`, not `right`: the hidden tail is at the writing direction's end,
  // which is the LEFT edge in Hebrew.
  departureFade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    end: 0,
    width: Spacing.five,
  },
});
