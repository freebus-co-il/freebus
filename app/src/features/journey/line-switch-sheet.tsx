import { IconCheck } from '@tabler/icons-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { currentOption, lineOptions, lineVerdict, type LineVerdict } from '@/features/trip/line-options';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime } from '@/lib/format';
import { hapticSelected } from '@/lib/haptics';

/**
 * "Which one are you on?" -- the whole of the journey screen's answer to a
 * rider who got on a different bus than the plan picked.
 *
 * This replaces a row of chips at the foot of every ride card. The chips were
 * a LIST where a QUESTION was wanted: five departures the rider had to read
 * and reject to reach the one thing that block was for. Behind a control, the
 * cost is one tap for the rider who needs it and nothing at all for everyone
 * else.
 *
 * Every run of the ride is offered, earlier ones included -- the rider may be
 * on the bus before the planned one -- and the planned run is listed and
 * ticked rather than hidden, so "I'm on the one you think" is a visible
 * answer and not an absence.
 */
export function LineSwitchSheet({
  leg, onChoose, onClose,
}: {
  /** The ride being switched; null closes the sheet. */
  leg: TransitLeg | null;
  onChoose: (tripId: string) => void;
  onClose: () => void;
}) {
  // Remember the leg this sheet last opened on. The caller's `leg` prop becomes
  // null the instant the rider picks a run, but the Modal is still animating
  // down. If we render null when leg goes null, the rows vanish mid-animation
  // and the rider sees a glitch. Instead, we hold the remembered leg through
  // the close so the content stays visible while the sheet slides out.
  const [rememberedLeg, setRememberedLeg] = useState<TransitLeg | null>(null);

  useEffect(() => {
    if (leg) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRememberedLeg(leg);
    }
  }, [leg]);

  return (
    <Modal transparent animationType="slide" visible={leg !== null} onRequestClose={onClose}>
      <SheetBackdrop onPress={onClose} />
      {rememberedLeg && (
        <LineSwitchSheetContent leg={rememberedLeg} onChoose={onChoose} onClose={onClose} />
      )}
    </Modal>
  );
}

function LineSwitchSheetContent({
  leg, onChoose, onClose,
}: {
  leg: TransitLeg;
  onChoose: (tripId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const sheetEdge = useSheetEdge();

  const options = lineOptions(leg);
  const current = currentOption(leg, options);

  const noteFor = (verdict: LineVerdict): { text: string; color: 'danger' | 'success' } | null => {
    switch (verdict.kind) {
      case 'slower':
        return { text: t('trip.lineLater', { minutes: verdict.minutesLater }), color: 'danger' };
      case 'sooner':
        return { text: t('trip.lineSooner', { minutes: verdict.minutesSooner }), color: 'success' };
      case 'misses':
        return { text: t('trip.lineMisses'), color: 'danger' };
      case 'same':
        return null;
    }
  };

  return (
    <ThemedView type="background" style={[styles.sheet, sheetEdge]}>
      <ThemedView style={[styles.grabber, { backgroundColor: theme.borderMuted }]} />
      <ThemedText type="subtitle">{t('journey.switchLine.title')}</ThemedText>

      <ScrollView style={styles.list}>
        {options.map((option) => {
          const mine = option.tripId === leg.tripId;
          const note = mine ? null : noteFor(lineVerdict(option, current));
          return (
            <Pressable
              key={option.tripId}
              accessibilityRole="button"
              accessibilityState={{ selected: mine }}
              onPress={() => {
                hapticSelected();
                onChoose(option.tripId);
                onClose();
              }}
              style={[styles.row, { borderBottomColor: theme.borderMuted }]}
            >
              <LineBadge route={option.route} />
              <ThemedText type="default" style={styles.time}>
                {formatClockTime(option.from.departureTime)}
              </ThemedText>
              {note && (
                <ThemedText type="smallBold" themeColor={note.color}>
                  {note.text}
                </ThemedText>
              )}
              {mine && (
                <View style={styles.mine}>
                  <ThemedText type="small" themeColor="textSecondary">
                    {t('journey.switchLine.current')}
                  </ThemedText>
                  <IconCheck size={16} color={theme.text} />
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    paddingTop: Spacing.two,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    gap: Spacing.three,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: Spacing.two,
  },
  // Bounded so a busy corridor's twenty runs cannot grow the sheet past the
  // screen.
  list: {
    maxHeight: 320,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  time: {
    flex: 1,
  },
  mine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
});
