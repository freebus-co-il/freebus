import { forwardRef } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '../theme';
import { Opacity, Radius, Size, type ColorRole } from '../tokens';
import { Glass } from './glass';
import { Icon, type IconName } from './icon';

export type IconButtonProps = {
  icon: IconName;
  /** Required: an icon alone says nothing to a screen reader. */
  accessibilityLabel: string;
  onPress?: () => void;
  onLongPress?: () => void;
  /** `glass` floats over content or a map; `filled` sits on a page; `plain` is
   *  the bare glyph, for rows and toolbars. */
  variant?: 'glass' | 'filled' | 'plain';
  size?: 'sm' | 'md';
  color?: ColorRole | (string & {});
  disabled?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A round, icon-only control. Its hit area is never smaller than `Size.touchMin`. */
export const IconButton = forwardRef<View, IconButtonProps>(function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  onLongPress,
  variant = 'glass',
  size = 'md',
  color = 'textPrimary',
  disabled = false,
  selected = false,
  style,
}, ref) {
  const colors = useColors();
  const box = Size.control[size];
  const slop = Math.max(0, (Size.touchMin - box) / 2);
  const glyph = <Icon name={icon} size={size === 'md' ? 'md' : 'sm'} color={selected ? 'onAccent' : color} weight="medium" />;
  const shape = { width: box, height: box, borderRadius: Radius.full };

  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={slop}
      android_ripple={{ color: colors.fillPressed, borderless: true, radius: box / 2 }}
      style={({ pressed }) => [
        disabled && { opacity: Opacity.disabled },
        pressed && variant !== 'glass' && Platform.OS === 'ios' && { opacity: Opacity.pressed },
        style,
      ]}
    >
      {variant === 'glass' && !selected ? (
        <Glass interactive shape="circle" style={[shape, styles.center]}>
          {glyph}
        </Glass>
      ) : (
        <View
          style={[
            shape,
            styles.center,
            selected && { backgroundColor: colors.accent },
            !selected && variant === 'filled' && { backgroundColor: colors.controlFill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.controlEdge },
          ]}
        >
          {glyph}
        </View>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
