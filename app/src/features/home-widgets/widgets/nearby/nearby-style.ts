/**
 * How the nearby stations widget draws: `map` leads with the closest station
 * on a map (its name in the map's panel) and lists the rest under it; `list`
 * is the rows alone, the closest one included, under the section's title.
 */
export type NearbyStyle = 'map' | 'list';

export const NEARBY_STYLES: readonly NearbyStyle[] = ['map', 'list'];

export const DEFAULT_NEARBY_STYLE: NearbyStyle = 'map';

export function parseNearbyStyle(raw: unknown): NearbyStyle {
  return raw === 'list' ? 'list' : DEFAULT_NEARBY_STYLE;
}
