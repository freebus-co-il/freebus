/**
 * The hand-off for the search morph: the home screen's "Where to?" capsule
 * growing into the location picker's search field, the way iOS 26 morphs glass
 * controls from one screen into the next.
 *
 * The home screen records where its capsule sits on screen just before it
 * navigates; the picker takes that frame once, draws a glass capsule there, and
 * springs it into its own field. Window coordinates, so the two screens agree
 * on where "there" is. Taken, not read: a picker opened any other way (results,
 * a share, the map) finds nothing and simply appears.
 */
export type MorphFrame = { x: number; y: number; width: number; height: number };

/** The home screen's two glass controls -- the search capsule, and the map
 *  button beside it, which flies into the field's own map button -- and the
 *  saved-location chips under them, which the picker's own row rises from. */
export type MorphOrigin = { search: MorphFrame; map: MorphFrame | null; chips: MorphFrame | null };

let pending: MorphOrigin | null = null;

export function setSearchMorphOrigin(origin: MorphOrigin) {
  pending = origin;
}

export function takeSearchMorphOrigin(): MorphOrigin | null {
  const frame = pending;
  pending = null;
  return frame;
}

/**
 * What the home screen hears while its controls are in flight. `out`: the
 * picker has taken over drawing them (home holds their slots empty and hides
 * its chips, which the picker's row stands in for). `back`:
 * they are flying home (home puts them back, under the picker's fading page,
 * so they are already there when the picker lifts away).
 */
export type MorphEvent = 'out' | 'back';
const listeners = new Set<(event: MorphEvent) => void>();

export function onSearchMorph(listener: (event: MorphEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSearchMorph(event: MorphEvent) {
  for (const listener of listeners) listener(event);
}
