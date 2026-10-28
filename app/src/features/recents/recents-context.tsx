import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  migrateStoredSearches, promote, recentSearchKey,
  type RecentLine, type RecentSearch, type RecentStation,
} from './recents';

export type { RecentLine, RecentSearch, RecentStation };

const STORAGE_KEY = 'freebus.recents.v1';

type StoredState = { lines: RecentLine[]; stations: RecentStation[]; searches: RecentSearch[] };

const EMPTY_STATE: StoredState = { lines: [], stations: [], searches: [] };

/**
 * Parses whatever is in storage defensively -- a format change or a
 * half-written value (the app killed mid-save) must degrade to "nothing
 * recent yet", never crash the tab on launch.
 */
function parseStoredState(raw: string | null): StoredState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw);
    return {
      lines: Array.isArray(parsed?.lines) ? parsed.lines : [],
      stations: Array.isArray(parsed?.stations) ? parsed.stations : [],
      // Reads BOTH shapes: `searches` as written now, and the `trips` any
      // install from before this change still has on disk. Dropping the
      // latter would silently empty a rider's list on upgrade, so the
      // destinations are carried across instead -- see
      // `migrateStoredSearches`.
      searches: migrateStoredSearches(parsed?.searches, parsed?.trips),
    };
  } catch {
    return EMPTY_STATE;
  }
}

function useRecentsState() {
  const [state, setState] = useState<StoredState>(EMPTY_STATE);
  /**
   * Whether anything in this session has actually RECORDED something.
   *
   * The save effect waits for it, so the only state ever written is state we
   * deliberately changed. Without it, two failure modes would both end in
   * silent, permanent data loss:
   *
   * - The initial empty state overwriting the disk before the read came back
   *   -- the trap saved-locations documents, which this same "have we loaded
   *   yet" flag also covers.
   * - `parseStoredState` falling into its catch. It promises to degrade to
   *   "nothing recent yet" rather than crash the tab, which is right for
   *   DISPLAY -- but a save effect with no such guard would then write that
   *   empty fallback straight back over the file, turning one bad read into
   *   a wipe the rider could never undo. Instead, a read that fails simply
   *   shows nothing until something is recorded, and the file survives to be
   *   read again next launch.
   */
  const [dirty, setDirty] = useState(false);
  // Readable from inside the load callback, which closed over `dirty` as it
  // was at mount.
  const dirtyRef = useRef(false);

  function markDirty() {
    dirtyRef.current = true;
    setDirty(true);
  }

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      // Never over the top of something already recorded. The read is a
      // local call made at mount and recording takes a tap, so this is a
      // race that should not happen -- but if it did, what it discarded
      // would be the rider's newest entry.
      setState((current) => (dirtyRef.current ? current : parseStoredState(raw)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, dirty]);

  function recordLine(line: RecentLine) {
    markDirty();
    setState((current) => ({ ...current, lines: promote(current.lines, line, (l) => l.lineCode) }));
  }

  function recordStation(station: RecentStation) {
    markDirty();
    setState((current) => ({
      ...current,
      stations: promote(current.stations, station, (s) => s.stopId),
    }));
  }

  function recordSearch(search: RecentSearch) {
    markDirty();
    setState((current) => ({ ...current, searches: promote(current.searches, search, recentSearchKey) }));
  }

  return {
    lines: state.lines,
    stations: state.stations,
    searches: state.searches,
    recordLine,
    recordStation,
    recordSearch,
  };
}

type RecentsContextValue = ReturnType<typeof useRecentsState>;

const RecentsContext = createContext<RecentsContextValue | null>(null);

export function RecentsProvider({ children }: { children: ReactNode }) {
  const value = useRecentsState();
  return <RecentsContext.Provider value={value}>{children}</RecentsContext.Provider>;
}

export function useRecents() {
  const value = useContext(RecentsContext);
  if (value === null) throw new Error('useRecents must be used inside a RecentsProvider');
  return value;
}
