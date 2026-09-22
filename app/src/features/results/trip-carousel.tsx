import { SnapCarousel } from '@/components/snap-carousel';

import type { ItineraryGroup } from './group-itineraries';
import { ItineraryCard } from './itinerary-card';

export type TripCarouselProps = {
  groups: ItineraryGroup[];
  /** Which departure within each group is showing, keyed by group signature. */
  activeTimeByGroup: Record<string, number>;
  /** Fired when a swipe settles on a different card. */
  onActiveIndexChange: (index: number) => void;
  onSelectTime: (groupIndex: number, group: ItineraryGroup, timeIndex: number) => void;
};

/** One trip per swipe. See `SnapCarousel` for how the active card is tracked. */
export function TripCarousel({ groups, activeTimeByGroup, onActiveIndexChange, onSelectTime }: TripCarouselProps) {
  return (
    <SnapCarousel
      data={groups}
      keyExtractor={(group) => group.signature}
      onActiveIndexChange={onActiveIndexChange}
      renderItem={(group, index) => (
        <ItineraryCard
          instances={group.instances}
          activeIndex={activeTimeByGroup[group.signature] ?? 0}
          onSelectTime={(timeIndex) => onSelectTime(index, group, timeIndex)}
        />
      )}
    />
  );
}
