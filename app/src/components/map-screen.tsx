import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconBack } from '@/components/directional-icon';
import { MAP_BACK_CHIP_GAP, MAP_BACK_CHIP_SIZE, MapSheet } from '@/components/map-sheet';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A page that is a map first: the map fills the screen, a back chip floats
 * over its top corner, and the page's content lives in the drawer.
 *
 * The map is an ordinary in-flow child, never absolute-filled -- an
 * absolute-filled map receives no touches at all (see `results.tsx`), and on
 * these pages the map is meant to be panned and zoomed.
 */
export function MapScreen({ map, children }: { map: ReactNode; children: ReactNode }) {
  const theme = useTheme();

  function back() {
    // A deep link straight into one of these pages has no history to pop.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  return (
    <ThemedView type="background" style={styles.container}>
      {map}
      <MapSheet>{children}</MapSheet>
      {/* After the drawer, so the chip is drawn -- and takes touches -- above
          it. The drawer stops just below the chip at full height, but the
          way back must never be covered, even mid-drag. */}
      <SafeAreaView style={styles.topBar} edges={['top']} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          onPress={back}
          hitSlop={Spacing.two}
          style={[styles.backChip, { backgroundColor: theme.background }]}
        >
          <IconBack size={22} color={theme.text} />
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    start: 0,
    paddingTop: MAP_BACK_CHIP_GAP,
    paddingHorizontal: Spacing.three,
  },
  // Flat, like every chip in this app: background only, no shadow.
  backChip: {
    width: MAP_BACK_CHIP_SIZE,
    height: MAP_BACK_CHIP_SIZE,
    borderRadius: MAP_BACK_CHIP_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
