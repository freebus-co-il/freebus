import type { SelectedPlace } from '@/lib/place';

/** The icons offered in the picker grid when creating/editing a custom saved
 *  location -- presets use `home`/`briefcase` directly, never through this list. */
export const LOCATION_ICON_NAMES = [
  'map-pin',
  'star',
  'heart',
  'school',
  'briefcase',
  'dumbbell',
  'shopping-cart',
  'coffee',
  'plane',
  'home',
] as const;

export type LocationIconName = (typeof LOCATION_ICON_NAMES)[number];

export type PresetId = 'home' | 'work';

/** A single chip on the home screen -- `place` is only ever `null` for a
 *  preset that hasn't been assigned an address yet (a custom location is
 *  never created without one, see `save-location.tsx`). */
export type SavedLocation = {
  id: PresetId | string;
  label: string;
  icon: LocationIconName;
  place: SelectedPlace | null;
  /** Presets (`home`/`work`) have a fixed identity -- always shown, can't be
   *  renamed or removed, only assigned a place. Custom locations are the
   *  opposite: freely named/iconed, and only exist once created. */
  isPreset: boolean;
};
