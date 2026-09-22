import { LIGHT_RAIL_ROUTE_TYPE, RAIL_ROUTE_TYPE } from "./routeTypes.js";

/**
 * The sign a stop shows on the map and at the head of a list row: the brand a
 * rider looks for on the street, by what calls there.
 */
export type StationKind =
  | "bus"
  | "train"
  /** Tel Aviv's light rail, the Dankal network: every light rail but Jerusalem's. */
  | "lightRail"
  | "jerusalemLightRail"
  | "carmelit"
  | "metronit";

/**
 * Where two kinds call at one stop, the earlier sign wins: the rarer, fixed
 * station is the one a rider is looking for. In today's feed the only real
 * overlap is the Metronit's street stops, about half of which ordinary buses
 * share.
 */
const PRECEDENCE: readonly StationKind[] = [
  "train", "lightRail", "jerusalemLightRail", "carmelit", "metronit", "bus",
];

/** GTFS `agency_id` of the Jerusalem Light Rail's operator (CityPass, כפיר).
 *  Both light rail networks share `route_type` 0, and the Jerusalem one has
 *  its own brand; any other operator's light rail is Tel Aviv's Dankal. */
export const JERUSALEM_LIGHT_RAIL_AGENCY_ID = "21";

/** GTFS `agency_id` of the Carmelit. Its `route_type` (5) is the Haifa cable
 *  car's too, so the operator is what tells the two apart. */
export const CARMELIT_AGENCY_ID = "20";

/**
 * The Metronit's ministry line codes, the first field of `route_desc`. The
 * feed files the Metronit as an ordinary bus run by Superbus -- which runs
 * dozens of ordinary Haifa lines too, and `route_color` does not mark it -- so
 * these codes are the only thing that tells it apart. Each belongs to that one
 * operator in the feed. A line the ministry renumbers falls back to the bus
 * sign.
 */
export const METRONIT_LINE_CODES: ReadonlySet<string> = new Set(["83001", "67002", "67003", "62004"]);

/** A route row, as far as its sign goes. */
export interface SignRoute {
  type: number | null;
  agencyId: string | null;
  desc: string | null;
}

function kindOfRoute(route: SignRoute): StationKind {
  if (route.type === RAIL_ROUTE_TYPE) return "train";
  if (route.type === LIGHT_RAIL_ROUTE_TYPE) {
    return route.agencyId === JERUSALEM_LIGHT_RAIL_AGENCY_ID ? "jerusalemLightRail" : "lightRail";
  }
  if (route.agencyId === CARMELIT_AGENCY_ID) return "carmelit";
  const dash = route.desc?.indexOf("-") ?? -1;
  if (dash > 0 && METRONIT_LINE_CODES.has(route.desc!.slice(0, dash))) return "metronit";
  return "bus";
}

/** The sign for a stop these routes call at; `bus` for none at all. */
export function stationKindOf(routes: Iterable<SignRoute>): StationKind {
  let best = PRECEDENCE.length - 1;
  for (const route of routes) best = Math.min(best, PRECEDENCE.indexOf(kindOfRoute(route)));
  return PRECEDENCE[best]!;
}
