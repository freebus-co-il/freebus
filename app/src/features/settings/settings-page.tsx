import type { ReactNode, RefObject } from 'react';
import { StyleSheet } from 'react-native';
// Gesture Handler's, not React Native's: a drag inside the page (the Home
// screen editor's grips) and the page's own scroll then settle which one
// owns a touch, instead of the native scroll cancelling the drag. The legacy
// component, because those grips are legacy builder gestures, and Gesture
// Handler 3 sets no relation between the builder API and its hook API.
import { LegacyScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Layout, NativeHeader, Space, Surface } from '@/design-system';

/**
 * A page pushed from the Settings tab: a native header with the system back
 * button, and grouped sections under it. Every settings page uses this, so
 * adding one is a route file with its sections and nothing else.
 */
export function SettingsPage({ title, children, scrollEnabled = true, scrollRef }: {
  title: string;
  children: ReactNode;
  /** Off while something on the page is being dragged, so the page does not
   *  scroll out from under the finger. */
  scrollEnabled?: boolean;
  /** The page's scroll view, for a gesture inside the page that must win
   *  over it (`blocksExternalGesture`). */
  scrollRef?: RefObject<LegacyScrollView | null>;
}) {
  return (
    <Surface level="bgGrouped" style={styles.container}>
      <NativeHeader title={title} />
      {/* Not the top edge: the native header already clears it. */}
      <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.container}>
        <LegacyScrollView ref={scrollRef} contentContainerStyle={styles.content} scrollEnabled={scrollEnabled}>{children}</LegacyScrollView>
      </SafeAreaView>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.lg,
    paddingBottom: Layout.sectionGap,
    gap: Layout.sectionGap,
  },
});
