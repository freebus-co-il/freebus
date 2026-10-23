import { GlassContainer, GlassView } from 'expo-glass-effect';
import { requireNativeView } from 'expo';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { useColors, useGlassEnabled, useScheme } from '../theme';
import { Border, Radius } from '../tokens';

export type GlassVariant = 'regular' | 'clear' | 'tinted';
export type GlassShape = 'capsule' | 'circle' | 'rounded' | 'none';

export type GlassProps = ViewProps & {
  variant?: GlassVariant;
  /** Reacts to touch (iOS 26 shimmer and scale). For pressable glass. */
  interactive?: boolean;
  shape?: GlassShape;
  /** Override the tint of `tinted` (defaults to `accent`). */
  tint?: string;
  style?: StyleProp<ViewStyle>;
};

const SHAPES: Record<GlassShape, ViewStyle> = {
  capsule: { borderRadius: Radius.full },
  circle: { borderRadius: Radius.full },
  rounded: { borderRadius: Radius.xl },
  none: {},
};

/**
 * The functional layer's material: Liquid Glass on iOS 26, a solid floating
 * surface everywhere else and under Reduce Transparency. Only for chrome that
 * floats over content -- never for the content itself, never glass on glass.
 *
 * Never fade this with `opacity`: glass stops rendering at opacity 0. Swap the
 * `variant` instead, or fade a wrapper.
 */
export function Glass({ variant = 'regular', interactive = false, shape = 'capsule', tint, style, children, ...rest }: GlassProps) {
  const enabled = useGlassEnabled();
  const scheme = useScheme();
  const colors = useColors();
  const shapeStyle = SHAPES[shape];

  if (enabled) {
    return (
      <GlassView
        glassEffectStyle={variant === 'clear' ? 'clear' : 'regular'}
        tintColor={variant === 'tinted' ? (tint ?? colors.accent) : undefined}
        isInteractive={interactive}
        colorScheme={scheme}
        style={[shapeStyle, { overflow: 'hidden' }, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  const fallback: ViewStyle =
    variant === 'tinted'
      ? { backgroundColor: tint ?? colors.accent }
      : { backgroundColor: colors.surfaceFloating, borderWidth: Border.hairline, borderColor: colors.separator };
  return (
    <View style={[shapeStyle, fallback, { overflow: 'hidden' }, style]} {...rest}>
      {children}
    </View>
  );
}

/**
 * Adjacent glass that should read as one piece (a toolbar capsule, a stack of
 * map controls). Merges on iOS 26; a plain row or column elsewhere.
 */
export function GlassGroup({ spacing = 8, style, children }: { spacing?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const enabled = useGlassEnabled();
  if (enabled) return <GlassContainer spacing={spacing} style={style}>{children}</GlassContainer>;
  return <View style={style}>{children}</View>;
}

/**
 * The native glass view itself, animatable. `GlassView` is a plain function
 * component with no ref, which Reanimated cannot drive frame by frame; its
 * native view takes the same props, so the morph animates that directly.
 * iOS only -- there is no native glass view anywhere else.
 */
const AnimatedNativeGlass: ComponentType<ComponentProps<typeof Animated.View> & {
  glassEffectStyle?: 'regular' | 'clear';
  colorScheme?: 'light' | 'dark';
}> | null =
  Platform.OS === 'ios'
    ? Animated.createAnimatedComponent(requireNativeView('ExpoGlassEffect', 'GlassView') as ComponentType<ViewProps>)
    : null;

/**
 * A layer for glass shapes in flight (a morph between two screens' controls).
 *
 * Deliberately NOT a native glass container: shapes inside one cast a far
 * heavier, wider shadow than the same glass at rest, so the flight read as a
 * second layer and its shadow snapped lighter the moment the real controls
 * took over. Shapes in flight must therefore never overlap -- glass on glass
 * shows as two layers -- and one that disappears into another shrinks away
 * ahead of it instead.
 */
export function GlassMorphLayer({ children }: { children: ReactNode }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {children}
    </View>
  );
}

/**
 * One glass shape in a `GlassMorphLayer`, positioned and sized by an animated
 * style.
 */
export function GlassMorphShape({ style, shape = 'capsule', children }: {
  style: ComponentProps<typeof Animated.View>['style'];
  shape?: GlassShape;
  children?: ReactNode;
}) {
  const enabled = useGlassEnabled();
  const scheme = useScheme();
  const colors = useColors();
  if (enabled && AnimatedNativeGlass) {
    return (
      <AnimatedNativeGlass glassEffectStyle="regular" colorScheme={scheme} style={[SHAPES[shape], morphStyles.shape, style]}>
        {children}
      </AnimatedNativeGlass>
    );
  }
  return (
    <Animated.View
      style={[
        SHAPES[shape],
        morphStyles.shape,
        { backgroundColor: colors.surfaceFloating, borderWidth: Border.hairline, borderColor: colors.separator },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

const morphStyles = StyleSheet.create({
  shape: { position: 'absolute', overflow: 'hidden' },
});
