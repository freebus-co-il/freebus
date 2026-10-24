import { StyleSheet, View } from 'react-native';

import type { Departure } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { LiveIndicator } from '@/components/live-indicator';
import { Size, Space, Text, useColors } from '@/design-system';
import { departureTime } from '@/lib/departure-time';
import { formatDurationMinutes } from '@/lib/format';

function secondsUntil(iso: string, now: Date): number {
  return Math.max(0, (new Date(iso).getTime() - now.getTime()) / 1000);
}

/** One departure, read as a line of text rather than as an object: the
 *  route badge, then how long until it goes.
 *
 *  Not a capsule: a row of capsules reads as a row of
 *  buttons, and none of these is pressable -- the whole station row is.
 *  The pairing is carried by spacing instead: `Space.xs` inside a
 *  departure against `Space.lg` between them, so each time sits
 *  visibly closer to its own badge than to the next one. */
export function DepartureEntry(
  { departure, showLive, now }: { departure: Departure; showLive: boolean; now: Date },
) {
  const colors = useColors();
  const time = departureTime(departure.departureTime, departure.realtime);
  const live = showLive && time.live;

  return (
    <View style={styles.departure}>
      <LineBadge route={departure.route} size="small" />
      {live && <LiveIndicator color={colors.live} size={Size.icon.xs} />}
      <Text variant="footnote" numeric color={live ? 'live' : 'textSecondary'}>
        {formatDurationMinutes(secondsUntil(time.iso, now))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Tighter than the gap BETWEEN departures, which is the whole of what
  // binds a time to its own badge now that no capsule does.
  departure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
