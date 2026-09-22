import { IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react-native';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SectionGap, Spacing } from '@/constants/theme';
import { MapPickButton } from '@/features/map-picker/map-pick-button';
import { NearbyStops } from '@/features/nearby/nearby-stops';
import { Chip, SavedLocationChips } from '@/features/saved-locations/saved-location-chips';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import type { SavedLocation } from '@/features/saved-locations/types';
import { FieldShell } from '@/features/search/field-shell';
import { useSearch } from '@/features/search/search-context';
import { useDestinationNavigation } from '@/features/search/use-destination-navigation';
import { SmartSuggestion } from '@/features/smart-suggestion/smart-suggestion';
import { useTheme } from '@/hooks/use-theme';
import { hapticWarned } from '@/lib/haptics';

// The page is bare white and everything on it is an inline row; the only
// filled things are the search field and the saved-location chips, which is
// what makes them read as controls rather than content. Still just the one
// "Where to?" prompt, not the results screen's full
// origin+destination+swap layout, and led by a search glyph rather than that
// panel's origin/destination markers: this is the entry point to a search,
// not a trip that already has both sides to show.
export default function SearchScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const savedLocations = useSavedLocations();
  const search = useSearch();
  const sheetEdge = useSheetEdge();
  // `push`, not the default `replace` -- a saved-location chip is tapped
  // directly on this screen with no transient search screen in between, so
  // `replace`ing here would replace HOME ITSELF (see this hook's own doc
  // comment): results would land with nothing underneath it on the stack,
  // and going back from it would fail outright.
  const { waitingForOrigin, originFailed, selectDestination } = useDestinationNavigation('push');
  const [actionsFor, setActionsFor] = useState<SavedLocation | null>(null);

  function selectSavedLocation(location: SavedLocation) {
    if (location.place) {
      selectDestination(location.place);
      return;
    }
    // An unset preset has no place to search FROM here -- send them to the
    // picker to assign one; the chip itself only ever starts a trip.
    router.push({ pathname: '/location-picker', params: { field: location.id === 'home' ? 'saved-home' : 'saved-work' } });
  }

  function editLocation(location: SavedLocation) {
    setActionsFor(null);
    if (location.isPreset) {
      router.push({ pathname: '/location-picker', params: { field: location.id === 'home' ? 'saved-home' : 'saved-work' } });
      return;
    }
    router.push({ pathname: '/location-picker', params: { field: 'saved-edit', editId: location.id } });
  }

  function removeLocation(location: SavedLocation) {
    // The one destructive action on this screen, and it happens with no
    // confirmation step -- the chip is simply gone. Worth feeling.
    hapticWarned();
    setActionsFor(null);
    savedLocations.removeCustom(location.id);
  }

  if (waitingForOrigin) {
    return (
      <ThemedView type="background" style={styles.container}>
        <SafeAreaView style={styles.centered} edges={['top']}>
          <ActivityIndicator />
        </SafeAreaView>
      </ThemedView>
    );
  }

  // Every shortcut on this screen plans FROM where the rider is, so a failed
  // fix leaves nothing to plan from. Says so and offers the retry, instead of
  // leaving a spinner here forever: a new trip does not inherit the previous
  // trip's manually-picked origin, so this state is reachable.
  if (originFailed) {
    const state = search.originState;
    return (
      <ThemedView type="background" style={styles.container}>
        <SafeAreaView style={styles.centered} edges={['top']}>
          <ThemedText type="default" style={styles.originErrorText}>
            {t(state.status === 'error' && state.message === 'location_permission_denied'
              ? 'search.locationPermissionDenied'
              : 'search.locationUnavailable')}
          </ThemedText>
          <Pressable onPress={search.retryOrigin} style={styles.retry}>
            <ThemedText type="smallBold">{t('search.retryLocation')}</ThemedText>
          </Pressable>
          {/* Retrying is only worth offering while a fix might still arrive.
              Naming a starting point is the way out when it will not -- it
              is what makes this screen a fork rather than a dead end. */}
          <Pressable
            onPress={() =>
              router.push({ pathname: '/location-picker', params: { field: 'origin', andPlan: '1' } })
            }
            style={styles.retry}
          >
            <ThemedText type="smallBold">{t('search.chooseOrigin')}</ThemedText>
          </Pressable>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <ThemedView type="background" style={styles.container}>
      {/* Top edge only: the tab bar underneath already sits below the home
          indicator, so taking the bottom inset here too would push this
          column up by the height of that indicator and leave a dead band
          above the bar. Same reason `settings.tsx` asks for `top`. */}
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.searchRow}>
          <Pressable style={styles.searchField} onPress={() => router.push('/location-picker')}>
            <FieldShell>
              <IconSearch size={18} color={theme.text} />
              <ThemedText type="smallBold">{t('search.destinationPlaceholder')}</ThemedText>
            </FieldShell>
          </Pressable>
          <MapPickButton onPress={() => router.push('/map-picker')} />
        </View>

        <SavedLocationChips
          locations={savedLocations.locations}
          onSelect={selectSavedLocation}
          onLongPress={setActionsFor}
          footer={
            <Chip
              icon={IconPlus}
              label={t('savedLocations.add')}
              muted
              onPress={() => router.push({ pathname: '/location-picker', params: { field: 'saved-new' } })}
            />
          }
        />

        {/* Search and the saved-location shortcuts are pinned -- they are how
            you leave this screen, and both stay one thumb-reach away however
            far the content below has been scrolled. What scrolls is the
            answer and the list, as one column, so a tall suggestion card can
            push the stations down without either scrolling inside the other. */}
        <ScrollView
          style={styles.pageScroll}
          contentContainerStyle={styles.pageContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Above Nearby stops on purpose: an answer outranks a list of
              places to look. Renders nothing at all when there is no commute
              worth suggesting, so the list simply moves up. */}
          <SmartSuggestion onSelect={selectDestination} />

          <NearbyStops />
        </ScrollView>
      </SafeAreaView>


      <Modal transparent animationType="slide" visible={actionsFor !== null} onRequestClose={() => setActionsFor(null)}>
        <SheetBackdrop onPress={() => setActionsFor(null)} />
        <ThemedView type="background" style={[styles.sheet, sheetEdge]}>
          <ThemedView style={[styles.grabber, { backgroundColor: theme.borderMuted }]} />
          {actionsFor && (
            <>
              <ThemedText type="smallBold" style={styles.sheetTitle}>
                {actionsFor.label}
              </ThemedText>
              <Pressable style={styles.actionRow} onPress={() => editLocation(actionsFor)}>
                <IconPencil size={20} color={theme.text} />
                <ThemedText type="default">{t('savedLocations.edit')}</ThemedText>
              </Pressable>
              {!actionsFor.isPreset && (
                <Pressable style={styles.actionRow} onPress={() => removeLocation(actionsFor)}>
                  <IconTrash size={20} color={theme.danger} />
                  <ThemedText type="default" themeColor="danger">
                    {t('savedLocations.remove')}
                  </ThemedText>
                </Pressable>
              )}
            </>
          )}
        </ThemedView>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    // The search field and the shortcut chips are one cluster, and this is
    // also what separates that cluster from the scrolling column below it.
    gap: Spacing.five,
  },
  originErrorText: {
    textAlign: 'center',
  },
  retry: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  searchField: {
    flex: 1,
  },
  pageScroll: {
    flex: 1,
  },
  pageContent: {
    gap: SectionGap,
    paddingBottom: SectionGap,
  },
  sheet: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    paddingTop: Spacing.two,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    gap: Spacing.one,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: Spacing.two,
  },
  sheetTitle: {
    paddingBottom: Spacing.two,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
});
