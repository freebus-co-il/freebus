import { IconBus, IconCar, IconShip, IconTrain } from '@tabler/icons-react-native';

export type VehicleIconProps = {
  /** GTFS `route_type`. */
  type: number;
  size: number;
  color: string;
};

/** Rail-family GTFS route types: tram/light rail, subway, rail, cable tram,
 *  funicular, monorail. `@tabler/icons-react-native` ships no tram or cable-car
 *  glyph, so the whole family reads as a train -- closer than a bus, which is
 *  the only alternative. */
const RAIL_TYPES = new Set([0, 1, 2, 5, 7, 12, 100, 400, 900, 1400]);
const FERRY_TYPES = new Set([4, 1000]);
/** 8 is this feed's shared taxi (מונית שירות); 1500 is the extended taxi range. */
const TAXI_TYPES = new Set([8, 1500]);

/** The vehicle glyph for a GTFS route type, for the places a route has no
 *  short name to print -- every one of this feed's 1,071 rail routes, which
 *  would otherwise render an empty coloured pill. */
export function VehicleIcon({ type, size, color }: VehicleIconProps) {
  if (RAIL_TYPES.has(type)) return <IconTrain size={size} color={color} />;
  if (FERRY_TYPES.has(type)) return <IconShip size={size} color={color} />;
  if (TAXI_TYPES.has(type)) return <IconCar size={size} color={color} />;
  return <IconBus size={size} color={color} />;
}
