import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlanQuery } from '@/api/types';
import { useAppActive } from '@/hooks/use-app-active';
import { placeToQueryValue, type SelectedPlace } from '@/lib/place';

import { useCurrentLocation } from './use-current-location';

export type TimeMode = 'departAfter' | 'arriveBy';

function useSearchState() {
  const { t, i18n } = useTranslation();
  const [destination, setDestination] = useState<SelectedPlace | null>(null);
  const [originOverride, setOriginOverride] = useState<SelectedPlace | null>(null);
  const {
    state: originState,
    request: retryOrigin,
    refresh: refreshOrigin,
  } = useCurrentLocation(t('search.currentLocation'));

  const [timeMode, setTimeModeState] = useState<TimeMode>('departAfter');
  // `null` means "no explicit time chosen" -- for `departAfter` that means
  // live "now" (omit both params and let the backend default, so the value
  // never goes stale while the user lingers on the search screen). `arriveBy`
  // has no such "whenever" concept, so switching into it below always gives
  // it a concrete starting value.
  const [customTime, setCustomTime] = useState<Date | null>(null);

  // GTFS route_type values the rider has restricted the search to. Empty
  // means "all", and is the default. Deliberately NOT persisted across app
  // launches: a filter that silently survives a restart can hide results
  // indefinitely with no visible cause.
  const [selectedModes, setSelectedModes] = useState<number[]>([]);

  function setTimeMode(mode: TimeMode) {
    setTimeModeState(mode);
    setCustomTime((current) => (mode === 'arriveBy' && current === null ? new Date() : current));
  }

  const timeQuery: Pick<PlanQuery, 'departAfter' | 'arriveBy'> =
    timeMode === 'arriveBy'
      ? { arriveBy: (customTime ?? new Date()).toISOString() }
      : customTime
        ? { departAfter: customTime.toISOString() }
        : {};

  // An empty selection omits the parameter entirely rather than sending an
  // empty one. That is what makes "untick everything" mean "all"
  // structurally instead of by a special case at the call site: a missing
  // `modes` is already the backend's no-filter path, while a bare `modes=` is
  // the exact input its parser documents as historically dangerous (it used
  // to parse as "tram only").
  const modeQuery: Pick<PlanQuery, 'modes'> =
    selectedModes.length === 0 ? {} : { modes: selectedModes.join(',') };

  // On launch, and again whenever the app returns to the foreground. A launch
  // whose fix failed -- cold GPS indoors is routinely slower than the fix
  // deadline -- would otherwise leave every GPS-driven section of the home
  // screen empty until the app is killed, and a rider who backgrounded the
  // app at home and opens it at the stop needs the stop's position. With a fix
  // already on screen this refreshes it without blanking anything (see
  // `useCurrentLocation`). Otherwise only an explicit retry tap asks again.
  //
  // Only the launch may prompt. The permission prompt and Android's "turn on
  // location" dialog both background the app while they are up, so closing
  // either one lands right back here -- a return that prompted again looped
  // until Android tore the activity down.
  const appActive = useAppActive();
  const wasActive = useRef<boolean | null>(null);
  useEffect(() => {
    const launched = wasActive.current === null;
    const returned = wasActive.current === false && appActive;
    wasActive.current = appActive;
    if (launched) retryOrigin();
    else if (returned) refreshOrigin();
    // Both change identity only with the language of their label, which is no
    // reason to ask the device for a new fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appActive]);

  const origin = originOverride ?? (originState.status === 'success' ? originState.place : null);

  // The one /plan query both screens ask for. It lives here rather than in
  // `results.tsx` because the trip screen has to reproduce it EXACTLY: an
  // identical query key is what lets it read the itinerary straight out of
  // react-query's cache instead of being handed one through route params,
  // which would mean serialising a whole itinerary (encoded polylines and
  // all) into a URL. Null until both endpoints resolve; origin may still be
  // waiting on GPS.
  const planQuery: PlanQuery | null =
    origin && destination
      ? {
          from: placeToQueryValue(origin),
          to: placeToQueryValue(destination),
          ...timeQuery,
          ...modeQuery,
          lang: i18n.language,
        }
      : null;

  // Swaps the two places in place, rather than navigating anywhere -- once
  // swapped, origin is a fixed pick (the override), not live GPS, until the
  // user swaps again or picks a new destination and comes back through the
  // picker. Guarded by callers on both being non-null (nothing meaningful to
  // swap while origin is still resolving).
  function swapOriginDestination() {
    if (!origin || !destination) return;
    setOriginOverride(destination);
    setDestination(origin);
  }

  return {
    destination,
    setDestination,
    origin,
    setOriginOverride,
    originState,
    retryOrigin,
    swapOriginDestination,
    timeMode,
    setTimeMode,
    customTime,
    setCustomTime,
    timeQuery,
    planQuery,
    selectedModes,
    setSelectedModes,
    modeQuery,
  };
}

type SearchContextValue = ReturnType<typeof useSearchState>;

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const value = useSearchState();
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearch() {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error('useSearch must be used within a SearchProvider');
  return ctx;
}
