import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { newGeocodeSession, resolvePlace, reverseGeocode, searchAddresses } from '@/api/geocode';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { resolveSharedPlace } from '@/features/share-intent/resolve-shared-place';
import { resolveShortLink } from '@/features/share-intent/resolve-short-link';
import { useSearch } from '@/features/search/search-context';
import { useDestinationNavigation } from '@/features/search/use-destination-navigation';

/**
 * Where a location shared from another app lands.
 *
 * Both ways in end up here: the share sheet (handed over by
 * `share-intent-gate`) and a tapped `geo:` link (rewritten by
 * `+native-intent`). The screen exists because reading a share is not always
 * instant -- a short link has to be followed, an address geocoded -- and that
 * wait needs somewhere to be visible.
 *
 * Nothing here is a destination in itself: every outcome replaces this screen
 * with the trip, the picker, or an explanation, so backing out of any of them
 * returns to the home screen underneath rather than to a spinner.
 */
export default function ShareScreen() {
  const { t, i18n } = useTranslation();
  const { text } = useLocalSearchParams<{ text?: string }>();
  const search = useSearch();
  const { waitingForOrigin, originFailed, selectDestination } = useDestinationNavigation();
  const [unreadable, setUnreadable] = useState(false);
  // A share is read exactly once. Re-running it on a re-render would repeat
  // the network work and, worse, re-select a destination the rider may have
  // already changed on the results screen this replaces itself with.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    let cancelled = false;

    void (async () => {
      // One billing session for the search and the resolve that may follow it.
      const session = newGeocodeSession();
      const resolved = await resolveSharedPlace(
        text ?? '',
        {
          resolveLink: (url) => resolveShortLink(url),
          searchAddresses: (query) => searchAddresses(query, i18n.language, session),
          resolvePlace: (placeId) => resolvePlace(placeId, session),
          reverseLookup: async (lat, lon) => (await reverseGeocode(lat, lon, i18n.language))?.label ?? null,
        },
        t('share.sharedLocation'),
      );

      if (cancelled) return;

      if (resolved.kind === 'place') {
        selectDestination(resolved.place);
        return;
      }

      if (resolved.kind === 'ambiguous') {
        // What they shared, already typed in -- the picker is the app's own
        // answer to "which of these did you mean", so the share becomes a
        // search rather than a dead end.
        router.replace({ pathname: '/location-picker', params: { q: resolved.query } });
        return;
      }

      setUnreadable(true);
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the payload alone: language and the navigation
    // callbacks change identity across renders, and none of them should make
    // the app read the same share twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  if (unreadable) {
    return (
      <ThemedView type="background" style={styles.container}>
        <SafeAreaView style={styles.centered}>
          <ThemedText type="default" style={styles.message}>
            {t('share.unreadable')}
          </ThemedText>
          <Pressable onPress={() => router.replace('/location-picker')} style={styles.action}>
            <ThemedText type="smallBold">{t('share.searchInstead')}</ThemedText>
          </Pressable>
        </SafeAreaView>
      </ThemedView>
    );
  }

  // The destination is known and the trip is one GPS fix away -- the same
  // wait the home screen shows after tapping a saved-location chip, for the
  // same reason, so a share behaves no differently from a tap once it lands.
  if (originFailed) {
    return (
      <ThemedView type="background" style={styles.container}>
        <SafeAreaView style={styles.centered}>
          <ThemedText type="default" style={styles.message}>
            {t(
              search.originState.status === 'error' &&
                search.originState.message === 'location_permission_denied'
                ? 'search.locationPermissionDenied'
                : 'search.locationUnavailable',
            )}
          </ThemedText>
          <Pressable onPress={search.retryOrigin} style={styles.action}>
            <ThemedText type="smallBold">{t('search.retryLocation')}</ThemedText>
          </Pressable>
          <Pressable
            onPress={() =>
              router.replace({ pathname: '/location-picker', params: { field: 'origin', andPlan: '1' } })
            }
            style={styles.action}
          >
            <ThemedText type="smallBold">{t('search.chooseOrigin')}</ThemedText>
          </Pressable>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <ThemedView type="background" style={styles.container}>
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator />
        <ThemedText type="small" themeColor="textSecondary">
          {t(waitingForOrigin ? 'share.findingYou' : 'share.reading')}
        </ThemedText>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  message: {
    textAlign: 'center',
  },
  action: {
    paddingHorizontal: Spacing.four,
  },
});
