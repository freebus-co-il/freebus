import { beforeEach, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Pressable } from 'react-native';

import type { Departure } from '@/api/types';
import { Text } from '@/design-system';
import { FavoritesWidget } from '@/features/home-widgets/widgets/favorites/favorites-widget';
import { useHomeLayout } from '@/features/home-widgets/use-home-widgets';
import { fireEvent, render, screen } from '@/test-utils/render';

import { serializeFavorites, type Favorite, type FavoriteStation, type FavoriteStopLine } from './favorites';
import { FavoritesProvider, useFavorites } from './favorites-context';
import { useFavoriteToggle } from './use-favorite-toggle';

import { registerHomeWidget } from '@/features/home-widgets/registry';
import { favoritesWidget } from '@/features/home-widgets/widgets/favorites';

// The page a rider who never arranged it sees: the nearby list, on by
// default. A stand-in, because the real one draws a native map.
registerHomeWidget({ id: 'nearby', icon: 'stations', titleKey: '', descriptionKey: '', defaultOn: true, Component: () => null });
registerHomeWidget(favoritesWidget);

const board: { departures: Partial<Departure>[] } = { departures: [] };
jest.mock('@/api/departures', () => ({
  STATION_BOARD_LIMIT: 50,
  useStopDepartures: () => ({ data: board, isLoading: false }),
}));
// The real client reads the API's address at import; nothing here reaches it.
jest.mock('@/api/client', () => ({ apiGet: jest.fn() }));
jest.mock('@/api/meta', () => ({ useRealtimeAvailable: () => false }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const STORAGE_KEY = 'freebus.favorites.v1';

const central: FavoriteStation = { kind: 'station', stopId: '1000', name: 'Central' };
const line5North: FavoriteStopLine = {
  kind: 'stopLine', stopId: '1000', stopName: 'Central', lineCode: '10005', lineDirection: '1',
  shortName: '5', agencyId: '3', type: 3, headsign: 'North Terminal',
};

function departure(lineCode: string, lineDirection: string, minutes: number): Partial<Departure> {
  return {
    runId: `${lineCode}-${minutes}`, tripId: `${lineCode}-${minutes}`, lineCode, lineDirection,
    departureTime: new Date(Date.now() + minutes * 60_000).toISOString(),
    realtime: null,
    route: { routeId: lineCode, agencyId: '3', shortName: lineCode.slice(-1), longName: null, type: 3, color: null },
  };
}

async function seed(items: Favorite[], widgetOffered = false) {
  await AsyncStorage.setItem(STORAGE_KEY, serializeFavorites({ items, widgetOffered }));
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
  board.departures = [];
});

/** A star, the way the station screen draws one, with the page's layout. */
function Star({ favorite }: { favorite: Favorite }) {
  const { saved, toggle } = useFavoriteToggle(favorite);
  const { ids } = useHomeLayout();
  const { items } = useFavorites();
  return (
    <>
      <Pressable accessibilityRole="button" onPress={toggle}>
        <Text>{saved ? 'Saved' : 'Save'}</Text>
      </Pressable>
      <Text>{`layout:${ids.join(',')}`}</Text>
      <Text>{`count:${items.length}`}</Text>
    </>
  );
}

test('the first save puts the Favorites widget at the top of a never-arranged home page', async () => {
  await render(<FavoritesProvider><Star favorite={central} /></FavoritesProvider>);
  expect(await screen.findByText('layout:nearby')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('layout:favorites,nearby')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy();
  const stored = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY))!);
  expect(stored).toEqual({ version: 1, items: [central], widgetOffered: true });
});

test('a later save does not put back a widget the rider took off', async () => {
  await seed([], true);
  await render(<FavoritesProvider><Star favorite={central} /></FavoritesProvider>);
  // Let the stored state load before pressing.
  await screen.findByText('layout:nearby');
  await new Promise((resolve) => setTimeout(resolve, 0));

  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('count:1')).toBeTruthy();
  expect(screen.getByText('layout:nearby')).toBeTruthy();
});

test('the widget counts down to a pinned line going the pinned way only', async () => {
  await seed([line5North]);
  board.departures = [departure('10005', '1', 4), departure('10005', '2', 6), departure('10007', '1', 8)];

  await render(<FavoritesProvider><FavoritesWidget /></FavoritesProvider>);

  expect(await screen.findByText('Towards North Terminal')).toBeTruthy();
  expect(screen.getByText('4 min')).toBeTruthy();
  expect(screen.queryByText('6 min')).toBeNull();
  expect(screen.queryByText('8 min')).toBeNull();
});

test('a pinned line with nothing in the window says so', async () => {
  await seed([line5North]);
  await render(<FavoritesProvider><FavoritesWidget /></FavoritesProvider>);
  expect(await screen.findByText('None soon')).toBeTruthy();
});

test('with nothing saved, the widget says how to fill it', async () => {
  await render(<FavoritesProvider><FavoritesWidget /></FavoritesProvider>);
  expect(await screen.findByText(/Star a station/)).toBeTruthy();
});

test('touch and hold asks before removing a favorite', async () => {
  await seed([central]);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<FavoritesProvider><FavoritesWidget /></FavoritesProvider>);

  await fireEvent(await screen.findByRole('button', { name: /Central/ }), 'longPress');

  expect(alert).toHaveBeenCalledWith('Remove Central from favorites?', undefined, expect.any(Array));
});
