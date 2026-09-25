import { IconCheck } from '@tabler/icons-react-native';
import { useState } from 'react';
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
  // Remember the leg this sheet last opened on, on BOTH edges of the open/close
  // cycle. The caller's `leg` prop becomes null the instant the rider picks a
  // run, but the Modal is still animating down -- so on the closing edge we
  // hold the remembered leg through the close instead of rendering null and
  // letting the rows vanish mid-animation. Symmetrically, on the OPENING edge,
  // seeding `useState(leg)` and then adjusting during render (rather than in a
  // passive `useEffect`) means the very first committed frame already has
  // content: an effect-based copy runs one tick after that first frame, which
  // opens the Modal over an empty sheet until it flushes. React's own docs
  // endorse this render-time pattern for exactly this "adjust state from a
  // prop change" case.
  const [rememberedLeg, setRememberedLeg] = useState<TransitLeg | null>(leg);
  if (leg !== null && leg !== rememberedLeg) setRememberedLeg(leg);

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
          const time = formatClockTime(option.from.departureTime);
          // The line falls back to the mode name, same as the old chip did
          // (`features/trip/line-option-chips.tsx`, before this branch): a
          // rail route's `shortName` is empty on every one of this feed's
          // trips, and `LineBadge` draws a bare glyph for it with no label of
          // its own, so without this fallback a train row reads as nothing
          // but a time to a screen reader.
          const lineName = option.route.shortName?.trim() || t(`results.modeType.${option.route.type}`, { defaultValue: '' });
          const label = [
            t('trip.lineOption', { line: lineName, time }),
            note?.text,
            mine ? t('journey.switchLine.current') : null,
          ].filter(Boolean).join(', ');
          return (
            <Pressable
              key={option.tripId}
              accessibilityRole="button"
              accessibilityState={{ selected: mine }}
              accessibilityLabel={label}
              onPress={() => {
                // Only when the tap actually changes anything: re-picking the
                // run already chosen is a no-op (`withLineChosen` returns
                // null), and buzzing there teaches that the tap means nothing
                // (`app/AGENTS.md`, haptics).
                if (!mine) hapticSelected();
                onChoose(option.tripId);
                onClose();
              }}
              style={styles.row}
            >
              <LineBadge route={option.route} />
              <ThemedText type="default" style={styles.time}>
                {time}
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
  // No separator between rows, matching the sibling sheet
  // (`features/results/mode-filter-chip.tsx`): a per-row bottom border also
  // draws a line under the LAST row, which nothing else in the sheet does.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
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
