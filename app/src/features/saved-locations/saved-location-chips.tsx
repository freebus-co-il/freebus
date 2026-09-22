import type { Icon } from '@tabler/icons-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { hapticGestureRecognised } from '@/lib/haptics';

import { LOCATION_ICON_COMPONENTS } from './location-icons';
import type { SavedLocation } from './types';

export type ChipProps = {
  icon: Icon;
  label: string;
  /** A prompt rather than a shortcut: a preset with no address yet, or
   *  "Add". Drawn as an ordinary outlined control, where a real shortcut
   *  is solid -- see `Chip`. */
  muted?: boolean;
  /** Waiting on something before it can act -- the icon becomes a spinner
   *  in the same slot, so the chip keeps its width and the row does not
   *  jump. Not pressable while it lasts. */
  busy?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
};

/**
 * One pill in the row. Exported because the row's trailing action ("Add" on
 * the home screen) is the same object and has to stay that way.
 *
 * A real shortcut is SOLID -- a `text` fill with the page colour for ink,
 * and no outline, since a filled control wearing an edge reads as two
 * states at once. These are the one thing on the home screen the rider
 * presses to GO somewhere, and the weight is what separates them from the
 * rows of information under them.
 *
 * A `muted` chip stays an ordinary outlined control. Both kinds of muted
 * chip are prompts rather than shortcuts -- "Add", and a preset with no
 * address yet -- so neither has anywhere to send the rider, and neither
 * should look like it does.
 */
export function Chip({ icon: IconComponent, label, muted = false, busy = false, onPress, onLongPress }: ChipProps) {
  const theme = useTheme();
  const outline = useControlOutline();

  return (
    <Pressable
      disabled={busy}
      onPress={onPress}
      // The sheet this opens animates in a beat later, so the tap is the
      // only thing that says the press was long enough to count.
      onLongPress={onLongPress && (() => {
        hapticGestureRecognised();
        onLongPress();
      })}
    >
      <View
        style={[
          styles.chip,
          muted ? [{ backgroundColor: theme.background }, outline] : { backgroundColor: theme.text },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={muted ? theme.textSecondary : theme.background} />
        ) : (
          <IconComponent size={16} color={muted ? theme.textSecondary : theme.background} />
        )}
        <ThemedText type="smallBold" themeColor={muted ? 'textSecondary' : 'background'}>
          {label}
        </ThemedText>
      </View>
    </Pressable>
  );
}

export type SavedLocationChipsProps = {
  /** Which chips to draw, in order. The caller decides -- the home screen
   *  shows every saved location including the presets still waiting for an
   *  address, while a screen that can only USE a saved place passes just the
   *  ones that have one. */
  locations: SavedLocation[];
  onSelect: (location: SavedLocation) => void;
  /** Only where the chips can be managed. Omitted, they are shortcuts and
   *  nothing else -- a long press does nothing. */
  onLongPress?: (location: SavedLocation) => void;
  /** Leading chip in the same row, for an action that outranks the saved
   *  ones (the picker's "Current location"). */
  leading?: ReactNode;
  /** Trailing chip in the same row, for a screen that offers one more action
   *  after the saved ones (the home screen's "Add"). */
  footer?: ReactNode;
};

/**
 * The rider's saved places as a single horizontal row, scrolling sideways
 * once there are more of them than the screen is wide -- shared, because this
 * row appears on the home screen and again in the location picker, and two
 * copies of it would drift the moment either one is touched.
 */
export function SavedLocationChips({ locations, onSelect, onLongPress, leading, footer }: SavedLocationChipsProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // The picker shows this row under an autofocused field, so the keyboard
      // is up: the default ('never') would spend the first tap on dismissing
      // it and never fire the chip underneath. No effect on the home screen,
      // where nothing has focus to begin with.
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      {leading}
      {locations.map((location) => (
        <Chip
          key={location.id}
          icon={LOCATION_ICON_COMPONENTS[location.icon]}
          label={location.label}
          // An unset preset (Home/Work with no address yet) reads as a prompt
          // to set one, not as a real shortcut.
          muted={location.place === null}
          onPress={() => onSelect(location)}
          onLongPress={onLongPress ? () => onLongPress(location) : undefined}
        />
      ))}
      {footer}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
});
