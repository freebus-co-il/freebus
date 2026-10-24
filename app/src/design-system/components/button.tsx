import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors, useGlassEnabled } from '../theme';
import { Opacity, Radius, Size, Space, type ColorRole } from '../tokens';
import { Glass, GLASS_TARGET_CLIP } from './glass';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ButtonVariant = 'prominent' | 'glass' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Stretches to its container's width. */
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Every button. `prominent` is the one primary action on a screen; `glass` is
 * a secondary action floating over content; `secondary` sits on a page;
 * `plain` is text only. On iOS 26 `prominent`, `destructive` and `glass` are
 * real Liquid Glass. Heights come from `Size.control`. See design-system.md 5.3.
 */
export function Button({
  label,
  onPress,
  variant = 'prominent',
  size = 'lg',
  icon,
  fullWidth = false,
  disabled = false,
  loading = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: ButtonProps) {
  const colors = useColors();
  const glass = useGlassEnabled();
  const height = Size.control[size];
  const inactive = disabled || loading;

  const ink: ColorRole =
    variant === 'prominent' ? 'onAccent' : variant === 'destructive' ? 'onStatus' : variant === 'plain' ? 'accent' : 'textPrimary';
  const textVariant = size === 'sm' ? 'subheadline' : size === 'md' ? 'callout' : 'headline';

  const content = (
    <View style={[styles.content, { height, paddingHorizontal: size === 'sm' ? Space.md : Space.xl }]}>
      {loading ? (
        <ActivityIndicator color={colors[ink]} />
      ) : (
        <>
          {icon && <Icon name={icon} size={size === 'lg' ? 'md' : 'sm'} color={ink} weight="semibold" />}
          <Text variant={textVariant} emphasized color={ink} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </View>
  );

  const usesGlass = variant === 'glass' || ((variant === 'prominent' || variant === 'destructive') && glass);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      android_ripple={variant === 'plain' ? undefined : { color: colors.fillPressed, borderless: false }}
      style={({ pressed }) => [
        styles.shape,
        usesGlass ? GLASS_TARGET_CLIP : styles.clip,
        fullWidth ? styles.full : styles.hug,
        inactive && { opacity: Opacity.disabled },
        // Glass answers a press itself; everything else dims.
        pressed && !usesGlass && Platform.OS === 'ios' && { opacity: Opacity.pressed },
        style,
      ]}
    >
      {usesGlass ? (
        <Glass
          variant={variant === 'glass' ? 'regular' : 'tinted'}
          tint={variant === 'destructive' ? colors.danger : undefined}
          interactive
          shape="capsule"
        >
          {content}
        </Glass>
      ) : (
        <View
          style={[
            styles.fill,
            variant === 'prominent' && { backgroundColor: colors.accent },
            variant === 'destructive' && { backgroundColor: colors.danger },
            variant === 'secondary' && { backgroundColor: colors.controlFill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.controlEdge },
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The press target takes the pill's shape, so Android's ripple and focus
  // highlight follow it instead of drawing a square around it. Clipped only
  // when it holds no glass: glass grows past its frame under a touch.
  shape: { borderRadius: Radius.full },
  clip: { overflow: 'hidden' },
  full: { alignSelf: 'stretch' },
  hug: { alignSelf: 'flex-start' },
  fill: { borderRadius: Radius.full, overflow: 'hidden' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm },
});
