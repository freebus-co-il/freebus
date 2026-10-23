import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MAP_BACK_CHIP_GAP, MapSheet } from '@/components/map-sheet';
import { IconButton, Layout, Surface } from '@/design-system';
import { useTranslation } from 'react-i18next';

/**
 * A page that is a map first: the map fills the screen, a back chip floats
 * over its top corner, and the page's content lives in the drawer.
 *
 * The map is an ordinary in-flow child, never absolute-filled -- an
 * absolute-filled map receives no touches at all (see `results.tsx`), and on
 * these pages the map is meant to be panned and zoomed.
 */
export function MapScreen({ map, children, onBack }: {
  map: ReactNode;
  children: ReactNode;
  /** A step back within the page, tried first: true when it handled the press,
   *  and the page is left only when it returns false. Android's hardware back
   *  is the page's own to wire (`BackHandler`) -- this is the chip. */
  onBack?: () => boolean;
}) {
  const { t } = useTranslation();

  function back() {
    if (onBack?.()) return;
    // A deep link straight into one of these pages has no history to pop.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  return (
    <Surface level="bgPlain" style={styles.container}>
      {map}
      <MapSheet>{children}</MapSheet>
      {/* After the drawer, so the chip is drawn -- and takes touches -- above
          it. The drawer stops just below the chip at full height, but the
          way back must never be covered, even mid-drag. */}
      <SafeAreaView style={styles.topBar} edges={['top']} pointerEvents="box-none">
        <IconButton icon="chevronBack" accessibilityLabel={t('common.back')} onPress={back} variant="glass" />
      </SafeAreaView>
    </Surface>
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
    paddingHorizontal: Layout.pageInset,
  },
});
