import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { hapticGestureRecognised } from '@/lib/haptics';

import { useColors } from '../theme';
import { Opacity, Radius, Size, Space } from '../tokens';
import { Glass } from './glass';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ChipProps = {
  label: string;
  icon?: IconName;
  /** Selected: inverts to an `accent` fill and reports itself selected. */
  selected?: boolean;
  /** The `accent` fill without the selected state: a set saved place. */
  filled?: boolean;
  /** Shows a chevron: this chip opens a choice. */
  menu?: boolean;
  /** A place with nothing set yet, a locked filter: secondary ink. */
  muted?: boolean;
  /** Shows a lock and does nothing. */
  locked?: boolean;
  busy?: boolean;
  /** Floats over a map: Liquid Glass instead of the control fill, which
   *  washes out against map tiles. Not with `selected`/`filled`. */
  glass?: boolean;
  /** `info` is a non-interactive capsule on a nested surface. */
  variant?: 'action' | 'info';
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Leading content in place of an icon (a line badge). */
  leading?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** A capsule control: filters, saved places, a time choice. See design-system.md 5.3. */
export function Chip({
  label,
  icon,
  selected = false,
  filled = false,
  menu = false,
  muted = false,
  locked = false,
  busy = false,
  variant = 'action',
  glass = false,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  leading,
  style,
}: ChipProps) {
  const colors = useColors();
  const inverted = selected || filled;
  const ink = inverted ? 'onAccent' : muted || locked ? 'textSecondary' : 'textPrimary';
  const onGlass = glass && !inverted && variant !== 'info';
  const content = (
    <View
      style={[
        styles.chip,
        onGlass
          ? null
          : variant === 'info'
          ? { backgroundColor: colors.surfaceNested }
          : inverted
            ? { backgroundColor: colors.accent }
            : { backgroundColor: colors.controlFill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.controlEdge },
        variant === 'info' && styles.info,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={colors[ink]} /> : leading ?? (icon && <Icon name={icon} size="sm" color={ink} weight="medium" />)}
      <Text variant={variant === 'info' ? 'footnote' : 'subheadline'} emphasized={variant !== 'info'} color={ink} numberOfLines={1} numeric>
        {label}
      </Text>
      {locked ? <Icon name="lock" size="xs" color="textSecondary" /> : menu && <Icon name="chevronDown" size="xs" color={ink} weight="semibold" />}
    </View>
  );
  const body = onGlass ? <Glass interactive shape="capsule" style={styles.glassShell}>{content}</Glass> : content;

  if (variant === 'info' || (!onPress && !onLongPress)) {
    return (
      <View accessible accessibilityLabel={accessibilityLabel ?? label} accessibilityHint={accessibilityHint} style={style}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, disabled: locked || busy }}
      disabled={locked || busy}
      onPress={onPress}
      onLongPress={onLongPress && (() => {
        hapticGestureRecognised();
        onLongPress();
      })}
      android_ripple={{ color: colors.fillPressed }}
      style={({ pressed }) => [styles.target, pressed && Platform.OS === 'ios' && { opacity: Opacity.pressed }, style]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs + Space.xxs,
    height: Size.control.sm,
    paddingHorizontal: Space.md,
    borderRadius: Radius.full,
    alignSelf: 'flex-start',
  },
  glassShell: { alignSelf: 'flex-start' },
  target: { borderRadius: Radius.full, overflow: 'hidden', alignSelf: 'flex-start' },
  info: {
    height: Size.control.sm - Space.sm,
    paddingHorizontal: Space.sm,
    gap: Space.xs,
  },
});
