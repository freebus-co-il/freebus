import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SelectedPlace } from '@/lib/place';

import { useSearch } from './search-context';

/**
 * Picking a destination for a brand-new trip (the home screen's field, or a
 * saved-location chip) has no results screen yet to go back to -- origin may
 * still be resolving GPS, so this waits for it before creating one. Shared
 * between `index.tsx` and `location-picker.tsx`'s home-flow branch so the
 * wait-then-navigate logic isn't duplicated between the two entry points.
 *
 * `navigation` controls how that "create one" actually lands on the stack:
 * `location-picker` is a transient search screen pushed ON TOP of home, so
 * it should `replace` itself with results (stack ends as [home, results]).
 * A saved-location chip is tapped DIRECTLY on home with no such screen
 * in between -- `replace`ing there would replace HOME ITSELF, leaving
 * results with nothing underneath it and no way back (the exact "GO_BACK
 * was not handled" bug this fixes). That path needs `push` instead, so home
 * stays on the stack beneath results.
 */
export function useDestinationNavigation(navigation: 'push' | 'replace' = 'replace') {
  const search = useSearch();
  const [justSelected, setJustSelected] = useState<SelectedPlace | null>(null);
  // `push` (unlike `replace`) leaves this screen mounted underneath results,
  // so it keeps reacting to `search.origin` for as long as the rider stays
  // deeper in the stack -- swapping or re-picking origin/destination there
  // changes `search.origin` again, which would re-run the effect below and
  // push a SECOND, invisible results screen on top of the first without this
  // guard. This ref marks the current `justSelected` as already acted on, so
  // the effect fires its navigation exactly once per selection no matter how
  // many more times `search.origin` changes afterward.
  const navigatedRef = useRef(false);

  // Waiting for GPS is only reasonable while GPS might still arrive. Once
  // resolution has actually FAILED there is no origin coming, and a spinner
  // that waits for it never ends -- so the wait is abandoned and the caller
  // is told, which is the difference between "hold on" and "this is broken".
  const originFailed = justSelected !== null && !search.origin && search.originState.status === 'error';

  useEffect(() => {
    if (!justSelected || !search.origin || navigatedRef.current) return;
    navigatedRef.current = true;
    if (navigation === 'push') {
      router.push('/results');
    } else {
      router.replace('/results');
    }
  }, [justSelected, search.origin, navigation]);

  // Resets both the spinner and the "already navigated" guard on refocus --
  // without this, `waitingForOrigin` would stay stuck `true` forever once
  // the user returns, leaving them stranded on a spinner that will never
  // resolve (the effect above that would clear it already ran).
  useFocusEffect(
    useCallback(() => {
      setJustSelected(null);
      navigatedRef.current = false;
    }, []),
  );

  function selectDestination(place: SelectedPlace) {
    navigatedRef.current = false;
    // Every caller of this is starting a BRAND NEW trip from the home screen
    // -- the smart suggestion, a saved-location chip, the "Where to?" field.
    // An origin override belongs to the PREVIOUS trip: it is set by editing
    // the origin row on the results screen, or by swapping. Left in place it
    // silently becomes the starting point of the next journey too, so the
    // smart card -- which decides WHICH trip to offer from the live GPS fix
    // (see `resolveSmartTarget`) -- would then plan that trip from wherever
    // the rider last happened to type. Clearing it here puts origin back on
    // live GPS, which is what "take me home from here" has always meant.
    search.setOriginOverride(null);
    search.setDestination(place);
    setJustSelected(place);
  }

  return {
    waitingForOrigin: justSelected !== null && !originFailed,
    /** Origin resolution failed while this was waiting on it -- the caller
     *  must offer a way out rather than keep spinning. */
    originFailed,
    selectDestination,
  };
}
