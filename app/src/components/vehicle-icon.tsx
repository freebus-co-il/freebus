import { Icon, type IconName } from '@/design-system';

export type VehicleIconProps = {
  /** GTFS `route_type`. */
  type: number;
  size: number;
  color: string;
};

/** Rail-family GTFS route types: tram/light rail, subway, rail, cable tram,
 *  funicular, monorail. */
const RAIL_TYPES = new Set([0, 1, 2, 5, 7, 12, 100, 400, 900, 1400]);
const FERRY_TYPES = new Set([4, 1000]);
/** 8 is this feed's shared taxi (מונית שירות); 1500 is the extended taxi range. */
const TAXI_TYPES = new Set([8, 1500]);

export function vehicleIconName(type: number): IconName {
  if (RAIL_TYPES.has(type)) return 'train';
  if (FERRY_TYPES.has(type)) return 'ferry';
  if (TAXI_TYPES.has(type)) return 'taxi';
  return 'bus';
}

/** The vehicle glyph for a GTFS route type. */
export function VehicleIcon({ type, size, color }: VehicleIconProps) {
  return <Icon name={vehicleIconName(type)} size={size} color={color} />;
}
