import { FAVORITES_WIDGET_ID } from '@/features/favorites/offer-widget';

import type { HomeWidgetDefinition } from '../../registry';

import { FavoritesWidget } from './favorites-widget';

/** Saved stations and pinned lines, with their next departures. Not on by
 *  default: it joins the page on the rider's first save (see
 *  `useFavoriteToggle`). */
export const favoritesWidget: HomeWidgetDefinition = {
  id: FAVORITES_WIDGET_ID,
  icon: 'star',
  titleKey: 'homeWidgets.favoritesTitle',
  descriptionKey: 'homeWidgets.favoritesDescription',
  Component: FavoritesWidget,
};
