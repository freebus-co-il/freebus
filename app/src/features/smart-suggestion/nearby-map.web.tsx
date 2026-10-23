import { View, type StyleProp, type ViewStyle } from 'react-native';

import type { NearbyStop } from '@/api/types';
import type { EdgePadding } from '@/features/results/trip-map';
import type { VehicleMarker } from '@/features/results/vehicle-markers';

export type NearbyMapProps = {
  here: { lat: number; lon: number };
  stops: readonly NearbyStop[];
  vehicles: readonly VehicleMarker[];
  edgePadding: EdgePadding;
  style?: StyleProp<ViewStyle>;
};

/** Web draws no map; the card's glass panel carries the content alone. */
export function NearbyMap({ style }: NearbyMapProps) {
  return <View style={style} />;
}
