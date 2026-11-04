/**
 * The rider's home layout: an ordered list of widget ids. Pure and free of
 * the registry, which hands in what is registered, so it is tested under node.
 */

/**
 * The stored layout, as the page should draw it. `null` means the rider has
 * never edited it, which is the registry's default-on widgets. Ids nothing
 * registers any more (a widget a later build removed, or a downgrade) are
 * dropped, and a repeated id keeps only its first place. An empty list is a
 * real choice and stays empty.
 */
export function resolveLayout(
  stored: readonly string[] | null,
  registered: readonly string[],
  defaults: readonly string[],
): string[] {
  if (stored === null) return defaults.filter((id) => registered.includes(id));
  const out: string[] = [];
  for (const id of stored) {
    if (registered.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The stored value read back: a list of strings, or `null` for anything
 *  else (never edited, or unreadable, which both mean the default page). */
export function parseStoredLayout(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((value): value is string => typeof value === 'string');
}

/** Appends at the bottom: a new widget should not shove the rider's own lead
 *  widget down. A no-op for one already there. */
export function addToLayout(layout: readonly string[], id: string): string[] {
  return layout.includes(id) ? [...layout] : [...layout, id];
}

export function removeFromLayout(layout: readonly string[], id: string): string[] {
  return layout.filter((each) => each !== id);
}
