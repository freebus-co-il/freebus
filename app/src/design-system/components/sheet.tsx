import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '../theme';
import { Layout, Motion, Radius, Space } from '../tokens';
import { IconButton } from './icon-button';
import { Text } from './text';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** Pinned under the content: the sheet's actions. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Label for the close button; the sheet always has one. */
  closeLabel: string;
};

/**
 * An in-place sheet for a short task: a filter checklist, a time picker, a
 * choice of line. Floats inset with the device's corner radius on iOS (the iOS
 * 26 sheet shape) and docks full-width with a 32pt top radius on Android (the
 * Material 3 sheet). Tapping the scrim or the close button closes it.
 *
 * No grabber: it neither drags nor resizes, so a handle would promise a
 * gesture that isn't there. The scrim fades over the whole screen, the sheet
 * included, while the sheet itself slides up from the bottom edge.
 */
export function Sheet({ visible, onClose, title, footer, children, closeLabel }: SheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable accessibilityLabel={closeLabel} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} />
      <Animated.View
        entering={SlideInDown.springify().duration(Motion.smooth.duration).dampingRatio(Motion.smooth.dampingRatio)}
        style={[
          styles.sheet,
          // The grouped page, so a grouped list inside reads as a group.
          { backgroundColor: colors.bgGrouped },
          ios
            ? { marginHorizontal: Space.sm, marginBottom: Math.max(insets.bottom, Space.sm), borderRadius: Radius.xxl + Space.sm }
            : { paddingBottom: insets.bottom + Space.lg, borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl },
        ]}
      >
        <View style={styles.head}>
          {title ? (
            <Text variant="title3" style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          ) : (
            <View style={styles.title} />
          )}
          <IconButton icon="close" accessibilityLabel={closeLabel} onPress={onClose} variant="filled" size="sm" />
        </View>
        <View style={styles.body}>{children}</View>
        {footer && <View style={styles.footer}>{footer}</View>}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { marginTop: 'auto', paddingTop: Space.lg, paddingBottom: Space.lg, maxHeight: '85%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Layout.pageInset + Space.xs },
  title: { flex: 1 },
  body: { paddingTop: Space.md, flexShrink: 1 },
  footer: { flexDirection: 'row', gap: Space.sm, paddingHorizontal: Layout.pageInset, paddingTop: Space.lg },
});
