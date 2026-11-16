import { useHomeLayout } from '@/features/home-widgets/use-home-widgets';
import { usePreferences } from '@/features/preferences/preferences-context';

import type { Favorite } from './favorites';
import { useFavorites } from './favorites-context';
import { offerFavoritesWidget } from './offer-widget';

/**
 * Saving or removing one favorite, from the star on a station or line.
 *
 * The rider's first save also puts the Favorites widget on the home page,
 * because that is where a saved stop pays off; see `offerFavoritesWidget` for
 * where it lands. Offered once: a rider who then takes it off has answered.
 */
export function useFavoriteToggle(favorite: Favorite | null) {
  const { isFavorite, toggle, widgetOffered, markWidgetOffered } = useFavorites();
  const { homeLayout } = usePreferences();
  const { ids, setIds } = useHomeLayout();

  const saved = favorite !== null && isFavorite(favorite);

  function onToggle() {
    if (favorite === null) return;
    toggle(favorite);
    if (saved || widgetOffered) return;
    markWidgetOffered();
    const next = offerFavoritesWidget(ids, homeLayout !== null);
    if (next !== null) setIds(next);
  }

  return { saved, toggle: onToggle };
}
