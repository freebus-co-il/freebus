/**
 * The colour every surface draws a route in: its OPERATOR's colour, not the
 * feed's `route_color`.
 *
 * The feed does publish a `route_color`, but it carries no brand: the
 * ministry ships four values across the whole country (`FF9933`, `33CC33`,
 * `9933FF`, `3399FF`) and they mark a service CLASS, so Egged, Dan and Kavim
 * lines all wear the same orange. 82% of routes carry no value at all and
 * rail never does, so most of the network would fall back to one grey.
 * Colouring by operator instead means every route has a colour, and the
 * colour answers a question a rider actually asks -- who runs this bus.
 * `route.color` is still carried on the API type as feed data; nothing
 * renders it.
 */

import { operatorColor } from '@/constants/operator-colors';

/**
 * The colour for a route, from whoever operates it. Falls back to a neutral
 * only when the feed gives the route no `agency_id` at all.
 */
export function routeColor(route: { agencyId: string | null }): string {
  return operatorColor(route.agencyId) ?? UNKNOWN_OPERATOR_COLOR;
}

/**
 * Stand-in for a route whose feed entry names no operator. Deliberately a
 * neutral rather than a colour: every real operator has one, so a grey pill
 * reads as "unknown" instead of impersonating a fifteenth company.
 */
export const UNKNOWN_OPERATOR_COLOR = '#666666';

/**
 * Picks black or white text for a `#`-prefixed hex background using simple
 * perceived luminance, so the lighter operator colours (Metropoline's
 * `#ff8b00`, Electra Afikim's `#9aca3c`) stay readable.
 */
export function readableTextColor(backgroundHex: string): '#ffffff' | '#000000' {
  const [r, g, b] = hexToRgb(backgroundHex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

/** A `#`-prefixed hex colour at `alpha` opacity, as `rgba()` -- for a map
 *  stroke, which has no opacity of its own to fade with. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgb(hexColor: string): [number, number, number] {
  const hex = hexColor.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** The colour a walking leg is drawn in -- the map's polyline and the trip
 *  screen's step rail both use it, so a journey reads as one object across
 *  the two surfaces rather than two unrelated diagrams. */
export const WALK_LEG_COLOR = '#f59e0b';
