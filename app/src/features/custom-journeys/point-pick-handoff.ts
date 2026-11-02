import type { SelectedPlace } from '@/lib/place';

/**
 * A place picked for a journey being built, waiting for the editor
 * underneath the picker: `router.back()` carries no params, so the picker
 * leaves it here and the editor takes it when it is focused again (the same
 * hand-off as `map-pick-handoff`).
 *
 * `replacing` names the point being re-picked, or null for a new point.
 */
let pending: { place: SelectedPlace; replacing: string | null } | null = null;
let replacingNext: string | null = null;

/** Called by the editor as it opens the picker. */
export function expectPointPick(replacing: string | null): void {
  replacingNext = replacing;
  pending = null;
}

/** Called by the picker with the place chosen. */
export function leavePointPick(place: SelectedPlace): void {
  pending = { place, replacing: replacingNext };
  replacingNext = null;
}

export function takePointPick(): { place: SelectedPlace; replacing: string | null } | null {
  const pick = pending;
  pending = null;
  return pick;
}
