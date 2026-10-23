import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '../theme';
import { Opacity, Radius, Space } from '../tokens';
import { Glass } from './glass';

export type CardProps = {
  children: ReactNode;
  /** `default` sits on the grouped page; `floating` sits over a map on a solid
   *  surface; `glass` sits over a map as Liquid Glass (solid fallback off
   *  iOS 26); `hero` clips its content (a map preview). */
  variant?: 'default' | 'floating' | 'glass' | 'hero';
  padded?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Dims the card: a completed step. */
  done?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A content block outside a list. No border, no shadow. See design-system.md 5.4. */
export function Card({ children, variant = 'default', padded = true, onPress, onLongPress, accessibilityLabel, accessibilityHint, done, style }: CardProps) {
  const colors = useColors();
  if (variant === 'glass') {
    const pressable = !!(onPress || onLongPress);
    // The caller's `style` goes on the OUTER element only, or margins double.
    const body = (
      <Glass
        interactive={pressable}
        shape="rounded"
        style={[styles.card, padded && styles.padded, done && { opacity: Opacity.done }, pressable ? styles.fill : style]}
      >
        {children}
      </Glass>
    );
    if (!pressable) return body;
    // Glass answers a touch itself (iOS 26); the solid fallback dims.
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        onLongPress={onLongPress}
        android_ripple={{ color: colors.fillPressed }}
        style={({ pressed }) => [styles.glassTarget, style, pressed && Platform.OS !== 'ios' && { opacity: Opacity.pressed }]}
      >
        {body}
      </Pressable>
    );
  }
  const surface: ViewStyle = {
    backgroundColor: variant === 'floating' ? colors.surfaceFloating : colors.surfaceGroup,
  };
  const base = [
    styles.card,
    surface,
    padded && styles.padded,
    variant === 'floating' && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator },
    done && { opacity: Opacity.done },
    style,
  ];
  if (!onPress && !onLongPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={{ color: colors.fillPressed }}
      style={({ pressed }) => [base, pressed && Platform.OS === 'ios' && { backgroundColor: colors.fillPressed }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.xl, overflow: 'hidden' },
  glassTarget: { borderRadius: Radius.xl, overflow: 'hidden' },
  fill: { flex: 1 },
  padded: { padding: Space.lg, gap: Space.sm },
});
