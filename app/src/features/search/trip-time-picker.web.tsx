import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, IconButton, Layout, Radius, SegmentedControl, Sheet, Space, Type, useColors } from '@/design-system';
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
  const colors = useColors();
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

          <View style={[styles.field, { backgroundColor: colors.surfaceNested }]}>
            <DateTimeInput
              type="datetime-local"
              value={toInputValue(displayDate)}
              onChange={(event: { target: { value: string } }) => {
                if (!event.target.value) return;
                setCustomTime(new Date(event.target.value));
              }}
              // A DOM element, so the design system's `Text` cannot style it:
              // the `headline` style is spelled out from its token instead.
              style={{
                fontSize: Type.headline.fontSize,
                fontWeight: Type.headline.fontWeight,
                fontVariantNumeric: 'tabular-nums',
                fontFamily: 'inherit',
                color: colors.textPrimary,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                width: '100%',
              }}
            />
          </View>
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
  field: {
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    borderRadius: Radius.md,
  },
  done: {
    flex: 1,
  },
});
