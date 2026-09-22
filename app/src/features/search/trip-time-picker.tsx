import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { IconChevronDown, IconClock, IconX } from '@tabler/icons-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, Pressable, StyleSheet } from 'react-native';

import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { SegmentedControl } from '@/components/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { formatPickerDateTime } from '@/lib/format';

import { useSearch, type TimeMode } from './search-context';

/** Android has no combined date+time mode -- open the date dialog, then
 *  chain into the time dialog on confirm, and merge them into one Date. */
function openAndroidPicker(initial: Date, onPicked: (date: Date) => void) {
  DateTimePickerAndroid.open({
    value: initial,
    mode: 'date',
    onValueChange: (_event, pickedDate) => {
      DateTimePickerAndroid.open({
        value: initial,
        mode: 'time',
        onValueChange: (_e, pickedTime) => {
          const combined = new Date(pickedDate);
          combined.setHours(pickedTime.getHours(), pickedTime.getMinutes());
          onPicked(combined);
        },
      });
    },
  });
}

/**
 * A single floating chip over the map, not a permanently-open panel -- the
 * segmented toggle and the time value only need screen space while the user
 * is actually changing them. Tapping it opens the full picker in a sheet.
 */
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

          {Platform.OS === 'android' ? (
            <Pressable onPress={() => openAndroidPicker(displayDate, setCustomTime)}>
              <ThemedView style={[styles.timeRow, { borderColor: theme.borderMuted }]}>
                <ThemedText type="default" style={styles.timeText}>
                  {summary}
                </ThemedText>
              </ThemedView>
            </Pressable>
          ) : (
            <DateTimePicker
              value={displayDate}
              mode="datetime"
              display="spinner"
              onValueChange={(_event, date) => setCustomTime(date)}
            />
          )}

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
  timeText: {
    fontSize: 18,
    fontWeight: '700',
  },
  doneButton: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
});
