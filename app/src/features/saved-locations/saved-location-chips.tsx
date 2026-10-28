import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { Chip, Space } from '@/design-system';

import { LOCATION_ICON_NAMES } from './location-icons';
import type { SavedLocation } from './types';

/**
 * The row's own pill IS the design-system `Chip` now. Re-exported so the
 * screens that put one more action in this row ("Add" on the home screen,
 * "Current location" in the picker) keep importing it from beside the row it
 * has to match -- the leading/trailing action and the saved places must stay
 * the same object.
 */
export { Chip };

export type SavedLocationChipsProps = {
  /** Which chips to draw, in order. The caller decides -- the home screen
   *  shows every saved location including the presets still waiting for an
   *  address, while a screen that can only USE a saved place passes just the
   *  ones that have one. */
  locations: SavedLocation[];
  onSelect: (location: SavedLocation) => void;
  /** Only where the chips can be managed. Omitted, they are shortcuts and
   *  nothing else -- a long press does nothing. The chip itself fires the
   *  "long press recognised" haptic, so callers must not fire it again. */
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
 *
 * A real shortcut is FILLED (the chip's `filled` look, an accent fill, without
 * announcing itself as selected):
 * these are the one thing on the home screen the rider presses to GO
 * somewhere, and the weight is what separates them from the rows of
 * information under them. A preset with no address yet is `muted` and
 * unfilled -- it is a prompt to set one, not a shortcut, and should not look
 * like it has anywhere to send the rider.
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
          icon={LOCATION_ICON_NAMES[location.icon]}
          label={location.label}
          filled={location.place !== null}
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
    gap: Space.sm,
  },
});
