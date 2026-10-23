import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { LiveIndicator } from '@/components/live-indicator';
import { Size, Space, Text, useColors } from '@/design-system';
import { formatClockTime } from '@/lib/format';

/** A move smaller than this is noise, not news. */
const DELTA_MIN_SECONDS = 60;
/** How long a change stays marked before the time stands alone again. */
const DELTA_SHOW_MS = 30_000;

/**
 * The journey's arrival, the way a satnav shows its ETA: always there, always
 * current, and briefly marked when it moves -- later in amber, sooner in
 * green -- so a rider glancing down sees that something changed without
 * having to remember what it said before.
 */
export function EtaHeader({ arrivalTime, live, color }: { arrivalTime: string; live: boolean; color?: string }) {
  const { t } = useTranslation();
  const colors = useColors();
  const [shown, setShown] = useState(arrivalTime);
  const [delta, setDelta] = useState<{ minutes: number } | null>(null);

  if (arrivalTime !== shown) {
    const seconds = (Date.parse(arrivalTime) - Date.parse(shown)) / 1000;
    setShown(arrivalTime);
    if (Math.abs(seconds) >= DELTA_MIN_SECONDS) {
      setDelta({ minutes: Math.round(seconds / 60) });
    }
  }

  useEffect(() => {
    if (delta === null) return;
    const timer = setTimeout(() => setDelta(null), DELTA_SHOW_MS);
    return () => clearTimeout(timer);
  }, [delta]);

  return (
    <View style={styles.row}>
      {live && <LiveIndicator color={color ?? colors.live} size={Size.icon.xs} />}
      <Text variant="subheadline" emphasized numeric color={color ?? 'textSecondary'}>
        {t('journey.sheet.arriveAt', { time: formatClockTime(arrivalTime) })}
      </Text>
      {delta !== null && (
        <Text variant="footnote" emphasized numeric color={delta.minutes > 0 ? 'warning' : 'live'}>
          {/* An LRM keeps the sign in front of the number in Hebrew. */}
          {`‎${delta.minutes > 0 ? '+' : '−'}${t('journey.sheet.deltaMinutes', { count: Math.abs(delta.minutes) })}`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
