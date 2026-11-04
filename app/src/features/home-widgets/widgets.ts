/**
 * The cards the rider can put on the home screen, in the order they pick.
 *
 * A closed catalogue rather than anything pluggable: each id is a component
 * the home screen knows how to draw (`home-widget.tsx`), and this file is the
 * one place a new one is named. Its glyph lives in `home-widget-icons.ts`, so
 * this file stays free of the design system and testable under node. The
 * layout the rider builds is just an ordered list of these ids, stored with
 * the other preferences.
 */
export type HomeWidgetId = 'nearby' | 'commute';

export type HomeWidgetDefinition = {
  id: HomeWidgetId;
  titleKey: string;
  descriptionKey: string;
};

/** Catalogue order: how the "add" list reads, not where a widget lands. */
export const HOME_WIDGETS: readonly HomeWidgetDefinition[] = [
  {
    id: 'nearby',
    titleKey: 'homeWidgets.nearbyTitle',
    descriptionKey: 'homeWidgets.nearbyDescription',
  },
  {
    id: 'commute',
    titleKey: 'homeWidgets.commuteTitle',
    descriptionKey: 'homeWidgets.commuteDescription',
  },
];

const KNOWN = new Set<string>(HOME_WIDGETS.map((widget) => widget.id));

/** What home looked like before it could be changed: the closest station's
 *  peek and the stations around it, alone. A rider who never opens the
 *  editor sees no difference. */
export const DEFAULT_HOME_WIDGETS: readonly HomeWidgetId[] = ['nearby'];

export function homeWidgetDefinition(id: HomeWidgetId): HomeWidgetDefinition {
  // Every id is in the catalogue by construction; the type says so.
  return HOME_WIDGETS.find((widget) => widget.id === id)!;
}

/**
 * The stored layout, read defensively like every other preference: anything
 * that is not a list falls back to the default, unknown ids (a widget a later
 * build removed, or a downgrade) are dropped, and a repeated id keeps only its
 * first place. An empty list is a real choice, not a bad blob.
 */
export function parseHomeWidgets(raw: unknown): HomeWidgetId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_HOME_WIDGETS];
  const seen = new Set<string>();
  const out: HomeWidgetId[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !KNOWN.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value as HomeWidgetId);
  }
  return out;
}

/** The catalogue's widgets that are not on the page yet. */
export function availableHomeWidgets(layout: readonly HomeWidgetId[]): HomeWidgetDefinition[] {
  return HOME_WIDGETS.filter((widget) => !layout.includes(widget.id));
}

/** Appends at the bottom: a new card should not shove the rider's own lead
 *  card down. A no-op for one already there. */
export function addHomeWidget(layout: readonly HomeWidgetId[], id: HomeWidgetId): HomeWidgetId[] {
  return layout.includes(id) ? [...layout] : [...layout, id];
}

export function removeHomeWidget(layout: readonly HomeWidgetId[], id: HomeWidgetId): HomeWidgetId[] {
  return layout.filter((widget) => widget !== id);
}

/** One place up (`-1`) or down (`1`). A no-op past either end or for an id
 *  that is not on the page. */
export function moveHomeWidget(
  layout: readonly HomeWidgetId[],
  id: HomeWidgetId,
  offset: -1 | 1,
): HomeWidgetId[] {
  const from = layout.indexOf(id);
  const to = from + offset;
  if (from === -1 || to < 0 || to >= layout.length) return [...layout];
  const next = [...layout];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
