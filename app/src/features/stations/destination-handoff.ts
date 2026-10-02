/** A place picked as a board's destination filter -- see `leaveDestination`. */
export interface PickedDestination {
  /** What the rider called it, for the chip. */
  name: string;
  /** Where it is. A POINT, not a stop: the rider names a railway station or
   *  a landmark, and the server decides which stops are near enough to count
   *  as arriving there. */
  lat: number;
  lon: number;
}

/**
 * The place chosen on the destination picker, waiting for the board
 * underneath it.
 *
 * Module state rather than route params, for the same reason
 * `map-pick-handoff` uses it: `router.back()` carries none, and the board
 * must come back to exactly the screen the rider left -- its map where they
 * put it, its open departure still open. Pushing the board again with new
 * params would rebuild all of that.
 *
 * One slot, because only one board is ever waiting on a pick.
 */
let pending: PickedDestination | null = null;

export function leaveDestination(destination: PickedDestination): void {
  pending = destination;
}

export function takeDestination(): PickedDestination | null {
  const picked = pending;
  pending = null;
  return picked;
}
