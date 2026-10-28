import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { useColors, useReduceMotion } from '../theme';
import { Radius, Size, Space, type ColorRole } from '../tokens';
import { Button } from './button';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type Tone = 'live' | 'warning' | 'danger' | 'neutral';
const TONE_INK: Record<Tone, ColorRole> = { live: 'live', warning: 'warning', danger: 'danger', neutral: 'textSecondary' };

/** A small status capsule: "Now", "Tight transfer", "Missed". */
export function Tag({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const colors = useColors();
  return (
    <View style={[styles.tag, { backgroundColor: colors.surfaceNested }]}>
      {icon && <Icon name={icon} size="xs" color={TONE_INK[tone]} weight="semibold" />}
      <Text variant="caption1" emphasized color={TONE_INK[tone]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** An 8pt status dot. */
export function StatusDot({ tone = 'live' }: { tone?: Tone }) {
  const colors = useColors();
  return <View style={[styles.dot, { backgroundColor: colors[TONE_INK[tone]] }]} />;
}

export type EmptyStateProps = {
  icon?: IconName;
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void };
  /** A quieter second way forward, under the first ("Choose origin" under "Try again"). */
  secondaryAction?: { label: string; onPress: () => void };
  /** Shows a spinner in place of the icon. */
  loading?: boolean;
  /** Extra content under the message (a "next service" line). */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** Nothing to show, an error, or a wait with an explanation. Centred. */
export function EmptyState({ icon = 'info', title, message, action, secondaryAction, loading, children, style }: EmptyStateProps) {
  const colors = useColors();
  return (
    <View style={[styles.empty, style]}>
      <View style={[styles.emptyTile, { backgroundColor: colors.surfaceNested }]}>
        {loading ? <ActivityIndicator color={colors.textSecondary} /> : <Icon name={icon} size="lg" color="textSecondary" />}
      </View>
      <Text variant="title3" align="center">
        {title}
      </Text>
      {message && (
        <Text variant="subheadline" color="textSecondary" align="center">
          {message}
        </Text>
      )}
      {children}
      {action && <Button label={action.label} onPress={action.onPress} variant="secondary" size="md" style={styles.emptyAction} />}
      {secondaryAction && (
        <Button label={secondaryAction.label} onPress={secondaryAction.onPress} variant="plain" size="md" style={styles.emptySecondary} />
      )}
    </View>
  );
}

export type BannerProps = {
  tone?: Tone;
  icon?: IconName;
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void; icon?: IconName };
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** A persistent, inline notice: off plan, no realtime, location off. */
export function Banner({ tone = 'neutral', icon = 'info', title, message, action, children, style }: BannerProps) {
  const colors = useColors();
  return (
    <View style={[styles.banner, { backgroundColor: colors.surfaceGroup }, style]}>
      <View style={styles.bannerHead}>
        <Icon name={icon} size="md" color={TONE_INK[tone]} weight="semibold" />
        <View style={styles.bannerText}>
          <Text variant="headline">{title}</Text>
          {message && (
            <Text variant="subheadline" color="textSecondary">
              {message}
            </Text>
          )}
        </View>
      </View>
      {children}
      {action && <Button label={action.label} icon={action.icon} onPress={action.onPress} variant="prominent" size="md" fullWidth />}
    </View>
  );
}

/** A placeholder block for content with a known shape. Pulses gently. */
export function Skeleton({ width, height = 14, radius = Radius.xs, style }: { width: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const reduce = useReduceMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reduce) return;
    pulse.set(withRepeat(withTiming(0.5, { duration: 900 }), -1, true));
  }, [pulse, reduce]);
  const animated = useAnimatedStyle(() => ({ opacity: pulse.get() }));
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: colors.trackFill }, animated, style]} />;
}

/** A list row's worth of skeleton: title and a subtitle line. */
export function SkeletonRow() {
  return (
    <View style={styles.skeletonRow}>
      <Skeleton width="55%" height={16} />
      <Skeleton width="80%" height={12} />
    </View>
  );
}

/** A centred spinner for a wait of unknown length. */
export function Loading({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  return (
    <View style={[styles.loading, style]}>
      <ActivityIndicator color={colors.textSecondary} />
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xxs,
    alignSelf: 'flex-start',
    paddingHorizontal: Space.sm,
    paddingVertical: Space.xxs,
    borderRadius: Radius.sm,
  },
  dot: { width: Space.sm, height: Space.sm, borderRadius: Radius.full },
  empty: { alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.xxl, paddingVertical: Space.huge },
  emptyTile: {
    width: Size.control.lg,
    height: Size.control.lg,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  emptyAction: { alignSelf: 'center', marginTop: Space.sm },
  emptySecondary: { alignSelf: 'center' },
  banner: { borderRadius: Radius.xl, padding: Space.lg, gap: Space.md },
  bannerHead: { flexDirection: 'row', gap: Space.md, alignItems: 'flex-start' },
  bannerText: { flex: 1, gap: Space.xxs },
  skeletonRow: { gap: Space.sm, paddingVertical: Space.md, paddingHorizontal: Space.lg },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: Space.xxl },
});
