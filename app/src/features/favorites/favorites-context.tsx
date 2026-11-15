import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  EMPTY_FAVORITES, isFavorite, parseStoredFavorites, refreshFavorite, serializeFavorites, toggleFavorite,
  type Favorite, type FavoritesState,
} from './favorites';

const STORAGE_KEY = 'freebus.favorites.v1';

function useFavoritesState() {
  const [state, setState] = useState<FavoritesState>(EMPTY_FAVORITES);
  /**
   * Whether this session has changed anything. The save effect waits for it,
   * so only state the rider deliberately changed is ever written: neither the
   * empty initial state (before the read returns) nor the empty fallback of an
   * unreadable file may overwrite what is on disk. The same guard as recents;
   * see `useRecentsState`.
   */
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

  function markDirty() {
    dirtyRef.current = true;
    setDirty(true);
  }

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (cancelled || dirtyRef.current) return;
      setState(parseStoredFavorites(raw) ?? EMPTY_FAVORITES);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    AsyncStorage.setItem(STORAGE_KEY, serializeFavorites(state));
  }, [state, dirty]);

  function toggle(favorite: Favorite) {
    markDirty();
    setState((current) => ({ ...current, items: toggleFavorite(current.items, favorite) }));
  }

  /** A fresher snapshot of a saved favorite; a no-op (and no write) for one
   *  that is not saved or has not changed. */
  function refresh(favorite: Favorite) {
    if (refreshFavorite(state.items, favorite) === state.items) return;
    markDirty();
    setState((current) => ({ ...current, items: refreshFavorite(current.items, favorite) }));
  }

  function markWidgetOffered() {
    markDirty();
    setState((current) => ({ ...current, widgetOffered: true }));
  }

  return {
    items: state.items,
    widgetOffered: state.widgetOffered,
    isFavorite: (favorite: Favorite) => isFavorite(state.items, favorite),
    toggle,
    refresh,
    markWidgetOffered,
  };
}

type FavoritesContextValue = ReturnType<typeof useFavoritesState>;

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const value = useFavoritesState();
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites() {
  const value = useContext(FavoritesContext);
  if (value === null) throw new Error('useFavorites must be used inside a FavoritesProvider');
  return value;
}
