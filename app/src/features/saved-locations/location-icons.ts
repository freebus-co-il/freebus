import {
  IconBriefcase,
  IconCoffee,
  IconDumbbell,
  IconHeart,
  IconHome,
  IconMapPin,
  IconPlane,
  IconSchool,
  IconShoppingCart,
  IconStar,
  type Icon,
} from '@tabler/icons-react-native';

import type { LocationIconName } from './types';

export const LOCATION_ICON_COMPONENTS: Record<LocationIconName, Icon> = {
  'map-pin': IconMapPin,
  star: IconStar,
  heart: IconHeart,
  school: IconSchool,
  briefcase: IconBriefcase,
  dumbbell: IconDumbbell,
  'shopping-cart': IconShoppingCart,
  coffee: IconCoffee,
  plane: IconPlane,
  home: IconHome,
};
