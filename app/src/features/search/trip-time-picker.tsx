import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Chip, IconButton, Layout, ListRow, ListSection, SegmentedControl, Sheet, Space, Text, useScheme } from '@/design-system';
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
 *
 * A chosen time gets a clear button beside the chip (a chip has one action,
 * and opening the sheet is it), which goes straight back to "leave now".
 */
export function TripTimePicker() {
  const { t } = useTranslation();
  const scheme = useScheme();
  const { timeMode, setTimeMode, customTime, setCustomTime } = useSearch();
  const [open, setOpen] = useState(false);

  const displayDate = customTime ?? new Date();
  const summary =
    timeMode === 'departAfter' && customTime === null
      ? t('search.leaveNow')
      : formatPickerDateTime(displayDate, new Date());

  return (
    <>
      <View style={styles.chipRow}>
        <Chip label={summary} icon="time" menu glass onPress={() => setOpen(true)} />
        {customTime !== null && (
          <IconButton
            icon="close"
            size="sm"
            accessibilityLabel={t('common.clear')}
            onPress={() => {
              setCustomTime(null);
              setTimeMode('departAfter');
            }}
          />
        )}
      </View>

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        closeLabel={t('common.close')}
        footer={<Button label={t('search.done')} onPress={() => setOpen(false)} variant="prominent" size="lg" fullWidth style={styles.done} />}
      >
        <View style={styles.body}>
          <SegmentedControl
            value={timeMode}
            onChange={setTimeMode}
            options={[
              { value: 'departAfter' as TimeMode, label: t('search.leaveAt') },
              { value: 'arriveBy' as TimeMode, label: t('search.arriveBy') },
            ]}
          />

          {Platform.OS === 'android' ? (
            <ListSection>
              <ListRow
                title={<Text variant="headline" numeric>{summary}</Text>}
                accessory="chevron"
                accessibilityLabel={summary}
                onPress={() => openAndroidPicker(displayDate, setCustomTime)}
              />
            </ListSection>
          ) : (
            <DateTimePicker
              value={displayDate}
              mode="datetime"
              display="spinner"
              // The app's own scheme, not the phone's: the sheet is painted in
              // it, and a spinner left on the device scheme can draw white
              // digits on a white sheet.
              themeVariant={scheme}
              onValueChange={(_event, date) => setCustomTime(date)}
            />
          )}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  body: {
    paddingHorizontal: Layout.pageInset,
    gap: Space.lg,
  },
  done: {
    flex: 1,
  },
});
