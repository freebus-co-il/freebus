/** The Favorites home widget's id. Stable forever: it keys the stored layout. */
export const FAVORITES_WIDGET_ID = 'favorites';

/**
 * The home layout after the rider's first favorite, or `null` to leave it.
 *
 * On a page the rider never arranged, the widget goes FIRST: that page is our
 * default, and a stop the rider chose outranks the nearby list. On a page the
 * rider arranged, it goes LAST, so their own lead widget is not shoved down
 * (the rule `addToLayout` keeps for the editor too).
 */
export function offerFavoritesWidget(layout: readonly string[], arranged: boolean): string[] | null {
  if (layout.includes(FAVORITES_WIDGET_ID)) return null;
  return arranged ? [...layout, FAVORITES_WIDGET_ID] : [FAVORITES_WIDGET_ID, ...layout];
}
