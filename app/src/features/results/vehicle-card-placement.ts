/**
 * Where a vehicle's card goes on the map: above the bus, pointing at it.
 *
 * Pure arithmetic in the map view's own points (origin top-left, as
 * `pointForCoordinate` reports them), so the whole of the geometry can be
 * tested without a native map.
 */

export type ScreenPoint = { x: number; y: number };
export type MapSize = { width: number; height: number };

/** Space between the card and the map's left and right edges. */
export const CARD_MARGIN = 12;
/** The pointer under the card: a square turned 45°, half of it showing. */
export const ARROW_BOX = 12;
/** How far that turned square reaches below the card: half its diagonal. */
const ARROW_DROP = 9;
/** Half the vehicle dot, plus a hair, so the arrow's tip stops short of it. */
const BUS_CLEARANCE = 18;
/** Room under the bus for the age pill that hangs beneath its dot. */
const BELOW_BUS = 40;
/** Keeps the arrow off the card's rounded corners. */
const ARROW_EDGE_INSET = 28;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The card's `bottom` within the map, and its arrow's `left` within the card.
 * The card is laid out by its foot, so it grows upward from the bus whatever
 * its height.
 */
export function cardPlacement({ bus, map }: { bus: ScreenPoint; map: MapSize }): { bottom: number; arrowLeft: number } {
  const arrowCentre = clamp(bus.x, CARD_MARGIN + ARROW_EDGE_INSET, map.width - CARD_MARGIN - ARROW_EDGE_INSET);
  return {
    bottom: map.height - (bus.y - BUS_CLEARANCE - ARROW_DROP),
    arrowLeft: arrowCentre - CARD_MARGIN - ARROW_BOX / 2,
  };
}

/**
 * Where to centre the camera so the card fits above the bus, as a point in
 * the map's CURRENT view -- the caller turns it into a coordinate. Null when
 * the bus already has room: a camera that jumps on every tap is a camera
 * the rider stops trusting.
 *
 * The bus moves only as far as it has to -- down until the card clears
 * `insetTop` (whatever the screen floats over the map's top), or up until its
 * age label clears the bottom. On a map too short for both, the label wins:
 * the bus itself staying in sight matters more than the top of its card.
 */
export function cardPanTarget(
  { bus, map, cardHeight, insetTop }: { bus: ScreenPoint; map: MapSize; cardHeight: number; insetTop: number },
): ScreenPoint | null {
  const minY = insetTop + cardHeight + ARROW_DROP + BUS_CLEARANCE;
  const maxY = map.height - BELOW_BUS;
  const targetY = minY > maxY ? maxY : clamp(bus.y, minY, maxY);
  const inSideBounds = bus.x >= CARD_MARGIN + ARROW_EDGE_INSET && bus.x <= map.width - CARD_MARGIN - ARROW_EDGE_INSET;
  const targetX = inSideBounds ? bus.x : map.width / 2;
  if (targetX === bus.x && targetY === bus.y) return null;
  // Centring the camera on point c shifts everything by (centre - c); solve
  // for the c that lands the bus on its target.
  return { x: map.width / 2 + (bus.x - targetX), y: map.height / 2 + (bus.y - targetY) };
}
