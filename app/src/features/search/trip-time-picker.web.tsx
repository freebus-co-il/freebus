import { IconChevronDown, IconClock, IconX } from '@tabler/icons-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet } from 'react-native';

import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { SegmentedControl } from '@/components/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { formatPickerDateTime } from '@/lib/format';

import { useSearch, type TimeMode } from './search-context';

// `@react-native-community/datetimepicker` doesn't support web (see
// `trip-time-picker.tsx`); a plain `<input type="datetime-local">` is the
// closest native-feeling equivalent the browser offers, same fallback
// approach as `trip-map.web.tsx` for the native-only map view. Cast to `any`
// so JSX can use it as a host tag -- React Native's `JSX.IntrinsicElements`
// has no DOM elements, only its own components.
const DateTimeInput = 'input' as any;

/** `datetime-local`'s value has no timezone -- it's read/written against the
 *  browser's local wall-clock, matching what `Date`'s local getters/setters
 *  already assume, so no UTC conversion is needed either direction. */
function toInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Web mirror of `trip-time-picker.tsx` -- see its comment for why this is a
 *  single floating chip rather than a permanently-open panel over the map. */
export function TripTimePicker() {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const sheetEdge = useSheetEdge();
  const { timeMode, setTimeMode, customTime, setCustomTime } = useSearch();
  const [open, setOpen] = useState(false);

  const displayDate = customTime ?? new Date();
  const summary =
    timeMode === 'departAfter' && customTime === null
      ? t('search.leaveNow')
      : formatPickerDateTime(displayDate, new Date());

  return (
    <>
      <Pressable onPress={() => setOpen(true)}>
        <ThemedView type="background" style={[styles.chip, outline]}>
          <IconClock size={18} color={theme.text} />
          <ThemedText type="smallBold" style={styles.chipText}>
            {summary}
          </ThemedText>
          {customTime !== null ? (
            <Pressable
              onPress={() => {
                setCustomTime(null);
                setTimeMode('departAfter');
              }}
              hitSlop={Spacing.two}
            >
              <IconX size={16} color={theme.textSecondary} />
            </Pressable>
          ) : (
            <IconChevronDown size={16} color={theme.textSecondary} />
          )}
        </ThemedView>
      </Pressable>

      <Modal transparent animationType="slide" visible={open} onRequestClose={() => setOpen(false)}>
        <SheetBackdrop onPress={() => setOpen(false)} />
        <ThemedView type="background" style={[styles.sheet, sheetEdge]}>
          <ThemedView style={[styles.grabber, { backgroundColor: theme.borderMuted }]} />

          <SegmentedControl
            value={timeMode}
            onChange={setTimeMode}
            options={[
              { value: 'departAfter' as TimeMode, label: t('search.leaveAt') },
              { value: 'arriveBy' as TimeMode, label: t('search.arriveBy') },
            ]}
          />

          <ThemedView style={[styles.timeRow, { borderColor: theme.borderMuted }]}>
            <DateTimeInput
              type="datetime-local"
              value={toInputValue(displayDate)}
              onChange={(event: { target: { value: string } }) => {
                if (!event.target.value) return;
                setCustomTime(new Date(event.target.value));
              }}
              style={{
                fontSize: 18,
                fontWeight: 700,
                fontFamily: 'inherit',
                color: theme.text,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                width: '100%',
              }}
            />
          </ThemedView>

          <Pressable onPress={() => setOpen(false)} style={[styles.doneButton, { backgroundColor: theme.text }]}>
            <ThemedText type="smallBold" themeColor="background">
              {t('search.done')}
            </ThemedText>
          </Pressable>
        </ThemedView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
  chipText: {
    maxWidth: 180,
  },
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
  timeRow: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    borderRadius: Spacing.four,
    borderWidth: 1.5,
  },
  doneButton: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
});
