/** GTFS `route_type` for rail. */
export const RAIL_ROUTE_TYPE = 2;

/** GTFS `route_type` for tram, which this feed uses for light rail: the Tel
 *  Aviv Red Line (Dankal) and the Jerusalem Light Rail. */
export const LIGHT_RAIL_ROUTE_TYPE = 0;

/**
 * GTFS `route_type` -> an English display name.
 *
 * This name is a FALLBACK, not a localization path: `/modes` ships it so an
 * app build that predates a feed's new vehicle type can render "Trolleybus"
 * instead of a bare "715". Real display names live in the app's own
 * translation files, keyed by the numeric type, and win whenever they exist.
 * An unknown type therefore surfaces an untranslated English word -- the
 * accepted cost of the alternative being an integer.
 *
 * Covers the basic types (0-12) from the GTFS reference plus the extended
 * `route_type` ranges this feed actually uses -- Israel's MOT feed carries
 * 715 (on-demand rural service) alongside the ordinary 0/2/3/5/8.
 */
const ROUTE_TYPE_NAMES = new Map<number, string>([
  // Basic types, GTFS reference "Routes" table.
  [0, "Tram"],
  [1, "Subway"],
  [2, "Rail"],
  [3, "Bus"],
  [4, "Ferry"],
  [5, "Cable Tram"],
  [6, "Aerial Lift"],
  [7, "Funicular"],
  [11, "Trolleybus"],
  [12, "Monorail"],
  // Extended types. Only the group heads plus the specific values seen in
  // this feed -- enumerating all ~250 extended codes would be dead weight,
  // and anything missing degrades to the numeric fallback by design.
  [100, "Railway Service"],
  [200, "Coach Service"],
  [400, "Urban Railway Service"],
  [700, "Bus Service"],
  [715, "Demand and Response Bus Service"],
  [800, "Trolleybus Service"],
  [900, "Tram Service"],
  [1000, "Water Transport Service"],
  [1300, "Aerial Lift Service"],
  [1400, "Funicular Service"],
  [1500, "Taxi Service"],
]);

/** The GTFS name for `type`, or `Route type <n>` when it is not one we know. */
export function routeTypeName(type: number): string {
  return ROUTE_TYPE_NAMES.get(type) ?? `Route type ${type}`;
}
