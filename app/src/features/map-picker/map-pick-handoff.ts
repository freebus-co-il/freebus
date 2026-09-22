import type { SelectedPlace } from '@/lib/place';

/**
 * A place chosen on the map, waiting for the location picker underneath it.
 *
 * The map screen opened FROM the picker does not decide where a pick goes:
 * that depends on why the picker was opened (an origin, a saved place, a new
 * trip), and the picker already knows every one of those answers. So the map
 * leaves the pick here and goes back, and the picker takes it on focus and
 * commits it exactly as if the rider had tapped a row.
 *
 * Module state rather than route params because `router.back()` carries none,
 * and one slot because there is only ever one picker waiting.
 */
let pending: SelectedPlace | null = null;

export function leaveMapPick(place: SelectedPlace): void {
  pending = place;
}

export function takeMapPick(): SelectedPlace | null {
  const place = pending;
  pending = null;
  return place;
}
