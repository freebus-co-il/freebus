import { Icon } from '@/design-system';

export type LiveIndicatorProps = {
  size?: number;
  color: string;
};

/**
 * The mark that says a time came from a vehicle rather than a timetable: the
 * broadcast glyph, upright, which reads the same in Hebrew and English.
 *
 * Only ever rendered where `useRealtimeAvailable()` is true -- see that hook's
 * comment for why an app with no live feed must show neither this NOR a
 * "scheduled" counterpart.
 */
export function LiveIndicator({ size = 12, color }: LiveIndicatorProps) {
  return <Icon name="live" size={size} color={color} weight="semibold" />;
}
