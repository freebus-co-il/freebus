import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';

import { STATION_BOARD_LIMIT, useStopDepartures } from '@/api/departures';
import { useRealtimeAvailable } from '@/api/meta';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import { ListRow, ListSection, Space, Text } from '@/design-system';
import {
  stopLineDepartures, type Favorite, type FavoriteStation, type FavoriteStopLine,
} from '@/features/favorites/favorites';
import { useFavorites } from '@/features/favorites/favorites-context';
import { DepartureCountdown } from '@/features/nearby/departure-entry';
import { DEPARTURES_PER_STATION, DepartureLine } from '@/features/nearby/departure-line';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { lineKey } from '@/features/stations/station-line';
import { useNow } from '@/hooks/use-now';
import { hapticGestureRecognised } from '@/lib/haptics';

/** Departures a pinned line shows: the next one, and the one after it to
 *  plan by if the first is too close to make. */
const STOP_LINE_DEPARTURES = 3;

/**
 * Long-press asks before removing: the row is a shortcut the rider built,
 * and a stray press on a scrolling page must not undo it.
 */
function useConfirmRemove() {
  const { t } = useTranslation();
  const { toggle } = useFavorites();
  return (favorite: Favorite, name: string) => {
    hapticGestureRecognised();
    Alert.alert(t('favorites.removeTitle', { name }), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('favorites.remove'), style: 'destructive', onPress: () => toggle(favorite) },
    ]);
  };
}

function StationFavoriteRow({ favorite, lang, showLive, now }: {
  favorite: FavoriteStation; lang: string; showLive: boolean; now: Date;
}) {
  // The nearby list's own question, so a station that is both nearby and a
  // favorite is one request.
  const { data } = useStopDepartures(favorite.stopId, DEPARTURES_PER_STATION, lang);
  const departures = data?.departures ?? [];
  const confirmRemove = useConfirmRemove();

  return (
    <ListRow
      onPress={() => router.push({ pathname: '/station/[stopId]', params: { stopId: favorite.stopId, name: favorite.name } })}
      onLongPress={() => confirmRemove(favorite, favorite.name)}
      leading={<StationIcon kind={stationKindOf(favorite)} />}
      title={<Text variant="callout" emphasized numberOfLines={1}>{favorite.name}</Text>}
      subtitle={departures.length > 0 ? <DepartureLine departures={departures} showLive={showLive} now={now} /> : undefined}
      accessory="chevron"
      trailingAlign="title"
    />
  );
}

function StopLineFavoriteRow({ favorite, lang, showLive, now }: {
  favorite: FavoriteStopLine; lang: string; showLive: boolean; now: Date;
}) {
  const { t } = useTranslation();
  // The station screen's full board, not the short peek: a line that comes
  // once an hour must not be cut off a busy stop's first few rows. Shared with
  // the station screen's cache, so opening the row finds the board ready.
  const { data, isLoading } = useStopDepartures(favorite.stopId, STATION_BOARD_LIMIT, lang);
  const departures = stopLineDepartures(data?.departures ?? [], favorite).slice(0, STOP_LINE_DEPARTURES);
  const confirmRemove = useConfirmRemove();
  const towards = favorite.headsign.trim() === '' ? '' : formatHeadsign(favorite.headsign);
  const title = towards === '' ? favorite.stopName : t('line.direction', { name: towards });

  return (
    <ListRow
      onPress={() => router.push({
        pathname: '/station/[stopId]',
        params: { stopId: favorite.stopId, name: favorite.stopName, line: lineKey(favorite) },
      })}
      onLongPress={() => confirmRemove(favorite, `${favorite.shortName ?? ''} ${favorite.stopName}`.trim())}
      leading={<LineBadge route={favorite} />}
      title={<Text variant="callout" emphasized numberOfLines={1}>{title}</Text>}
      subtitle={towards === '' ? undefined : favorite.stopName}
      trailing={
        departures.length > 0 ? (
          <View style={styles.times}>
            {departures.map((departure) => (
              <DepartureCountdown
                key={`${departure.runId}:${departure.departureTime}`}
                departure={departure}
                showLive={showLive}
                now={now}
              />
            ))}
          </View>
        ) : isLoading ? undefined : (
          <Text variant="footnote" color="textSecondary">{t('favorites.noneSoon')}</Text>
        )
      }
      accessory="chevron"
    />
  );
}

/**
 * The rider's saved stations and pinned lines, each with its next departures,
 * so the stop they check every morning needs no taps at all. Saved lines are
 * not here: a line has no one stop to count down to (the Lines tab lists them).
 *
 * Only on the page once the rider has saved something (see
 * `useFavoriteToggle`) or added it themselves; with nothing to show, it says
 * how to fill it rather than vanishing from a page the rider put it on.
 */
export function FavoritesWidget() {
  const { t, i18n } = useTranslation();
  const showLive = useRealtimeAvailable();
  const now = useNow();
  const { items } = useFavorites();
  const shown = items.filter(
    (item): item is FavoriteStation | FavoriteStopLine => item.kind === 'station' || item.kind === 'stopLine',
  );

  if (shown.length === 0) {
    return (
      <ListSection title={t('favorites.title')}>
        <ListRow title={<Text variant="subheadline" color="textSecondary">{t('favorites.emptyHome')}</Text>} />
      </ListSection>
    );
  }

  return (
    <ListSection title={t('favorites.title')} footer={t('favorites.removeHint')}>
      {shown.map((item) => (item.kind === 'station' ? (
        <StationFavoriteRow key={`s:${item.stopId}`} favorite={item} lang={i18n.language} showLive={showLive} now={now} />
      ) : (
        <StopLineFavoriteRow
          key={`l:${item.stopId}:${item.lineCode}:${item.lineDirection}`}
          favorite={item}
          lang={i18n.language}
          showLive={showLive}
          now={now}
        />
      )))}
    </ListSection>
  );
}

const styles = StyleSheet.create({
  times: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
});
