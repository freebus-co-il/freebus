import { NearbyStops } from '@/features/nearby/nearby-stops';
import type { SelectedPlace } from '@/lib/place';

import { CommuteWidget } from './commute-widget';
import type { HomeWidgetId } from './widgets';

/** The closest station on the map, then ten more as rows under it. */
const HOME_NEARBY_STOPS = 11;

/**
 * One card of the rider's home layout. The ids are a closed set
 * (`widgets.ts`), so this is a switch rather than a registry of components.
 */
export function HomeWidget({ id, layout, onSelectDestination }: {
  id: HomeWidgetId;
  /** The whole layout, so a widget can step aside for another on the page. */
  layout: readonly HomeWidgetId[];
  onSelectDestination: (place: SelectedPlace) => void;
}) {
  switch (id) {
    case 'nearby':
      return <NearbyStops limit={HOME_NEARBY_STOPS} featureClosest />;
    case 'commute':
      return <CommuteWidget showsNearby={layout.includes('nearby')} onSelect={onSelectDestination} />;
  }
}
