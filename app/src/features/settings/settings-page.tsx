import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Layout, NativeHeader, Space, Surface } from '@/design-system';

/**
 * A page pushed from the Settings tab: a native header with the system back
 * button, and grouped sections under it. Every settings page uses this, so
 * adding one is a route file with its sections and nothing else.
 */
export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Surface level="bgGrouped" style={styles.container}>
      <NativeHeader title={title} />
      {/* Bottom edge only: the native header already clears the top. */}
      <SafeAreaView edges={['bottom']} style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
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
