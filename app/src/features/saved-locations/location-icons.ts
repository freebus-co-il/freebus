import type { IconName } from '@/design-system';

import type { LocationIconName } from './types';

/** The glyph each saved-place icon choice draws, as a design-system icon name. */
export const LOCATION_ICON_NAMES: Record<LocationIconName, IconName> = {
  'map-pin': 'pin',
  star: 'star',
  heart: 'heart',
  school: 'school',
  briefcase: 'work',
  dumbbell: 'fitness',
  'shopping-cart': 'shopping',
  coffee: 'cafe',
  plane: 'flight',
  home: 'home',
};
