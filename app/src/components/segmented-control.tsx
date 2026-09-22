import { Pressable, StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { hapticSelected } from '@/lib/haptics';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

export type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
};

/** A confident, monochrome two-or-more-way switch: an outlined track with a
 *  solid pill marking the active side, black-on-white (or the inverse in
 *  dark mode) rather than a brand color -- shared by the leave/arrive-by
 *  toggle and the results sort toggle so both read as one visual language.
 *
 *  The track is drawn at all because without it the inactive options are
 *  loose words with no shape saying they are the other halves of one
 *  control. */
export function SegmentedControl<T extends string>({ options, value, onChange }: SegmentedControlProps<T>) {
  const theme = useTheme();
  const outline = useControlOutline();

  return (
    <ThemedView type="background" style={[styles.track, outline]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            // Only on a real change: re-tapping the side already chosen is
            // not a selection, and buzzing there teaches the tap means
            // nothing.
            onPress={() => {
              if (!active) hapticSelected();
              onChange(option.value);
            }}
            style={styles.segmentWrap}
          >
            {/* `transparent` rather than no `backgroundColor` at all when
                inactive. Android builds the background drawable the first
                time a colour appears, and builds it WITHOUT the radius --
                so the pill was round until the rider moved it and square
                from then on. Declaring the colour from the first render
                means only its value ever changes. The track never had the
                bug because it is always filled. */}
            <View style={[styles.segment, { backgroundColor: active ? theme.text : 'transparent' }]}>
              <ThemedText type="smallBold" themeColor={active ? 'background' : 'textSecondary'}>
                {option.label}
              </ThemedText>
            </View>
          </Pressable>
        );
      })}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: 999,
    padding: Spacing.one,
  },
  segmentWrap: {
    flex: 1,
  },
  segment: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
});
