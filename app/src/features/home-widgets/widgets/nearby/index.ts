import type { HomeWidgetDefinition } from '../../registry';

import { NearbyOptions } from './nearby-options';
import { DEFAULT_NEARBY_STYLE, parseNearbyStyle, type NearbyStyle } from './nearby-style';
import { NearbyWidget } from './nearby-widget';

/** The closest stations and their next departures: home as it first shipped. */
export const nearbyWidget: HomeWidgetDefinition<NearbyStyle> = {
  id: 'nearby',
  icon: 'stations',
  titleKey: 'homeWidgets.nearbyTitle',
  descriptionKey: 'homeWidgets.nearbyDescription',
  defaultOn: true,
  Component: NearbyWidget,
  options: {
    defaults: DEFAULT_NEARBY_STYLE,
    parse: parseNearbyStyle,
    summaryKey: (style) => `homeWidgets.nearbyStyle.${style}`,
    Editor: NearbyOptions,
  },
};
