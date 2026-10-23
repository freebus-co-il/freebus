import { Host, Picker, Text as NativeText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { hapticSelected } from '@/lib/haptics';

import { useColors, useScheme } from '../theme';
import { Radius, Size, Space } from '../tokens';
import { Text } from './text';

export type SegmentedOption<T extends string> = { value: T; label: string };

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
};

/**
 * A two-to-four-way choice. On iOS it IS the system segmented control
 * (SwiftUI's segmented picker), so it is Liquid Glass on iOS 26 -- the
 * selection slides as a glass lens -- and the stock look before it. Elsewhere,
 * a track with the chosen segment raised in the same shape, so leave/arrive and
 * sort read the same everywhere. Ticks only on a real change.
 */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return Platform.OS === 'ios' ? <NativeSegmentedControl {...props} /> : <TrackSegmentedControl {...props} />;
}

function NativeSegmentedControl<T extends string>({ options, value, onChange }: SegmentedControlProps<T>) {
  const scheme = useScheme();
  return (
    // Sized by its content vertically, the row's width horizontally. The
    // system control has one height; `size` is the drawn track's concern.
    <Host matchContents={{ vertical: true }} colorScheme={scheme} style={styles.native}>
      <Picker<string>
        selection={value}
        onSelectionChange={(next) => {
          if (next === value) return;
          hapticSelected();
          onChange(next as T);
        }}
        modifiers={[pickerStyle('segmented')]}
      >
        {options.map((option) => (
          <NativeText key={option.value} modifiers={[tag(option.value)]}>
            {option.label}
          </NativeText>
        ))}
      </Picker>
    </Host>
  );
}

function TrackSegmentedControl<T extends string>({ options, value, onChange, size = 'md' }: SegmentedControlProps<T>) {
  const colors = useColors();
  const height = size === 'sm' ? Size.control.sm : Size.control.md - Space.xs;
  return (
    <View accessibilityRole="tablist" style={[styles.track, { backgroundColor: colors.trackFill, height }]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (!active) hapticSelected();
              onChange(option.value);
            }}
            style={styles.segmentWrap}
          >
            {/* Colour declared from the first render, `transparent` when idle:
                Android builds a background drawable without its radius the first
                time a colour appears. */}
            <View
              style={[
                styles.segment,
                { backgroundColor: active ? colors.segmentThumb : 'transparent' },
                active && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.controlEdge },
              ]}
            >
              {/* Shrinks before it truncates: Hebrew labels run long, and a
                  four-way choice gives each one a quarter of the width. */}
              <Text
                variant={options.length > 3 ? 'footnote' : 'subheadline'}
                emphasized={active}
                color={active ? 'textPrimary' : 'textSecondary'}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {option.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  native: { alignSelf: 'stretch' },
  track: { flexDirection: 'row', borderRadius: Radius.full, padding: Space.xxs },
  segmentWrap: { flex: 1 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.full, paddingHorizontal: Space.sm },
});
