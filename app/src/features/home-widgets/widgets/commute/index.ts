import type { HomeWidgetDefinition } from '../../registry';

import { CommuteOptions } from './commute-options';
import { DEFAULT_COMMUTE_SOURCE, parseCommuteSource, type CommuteSource } from './commute-source';
import { CommuteWidget } from './commute-widget';

/** The next trip, planned before the rider asks: Home and Work, two places,
 *  or a journey and its way back. */
export const commuteWidget: HomeWidgetDefinition<CommuteSource> = {
  id: 'commute',
  icon: 'work',
  titleKey: 'homeWidgets.commuteTitle',
  descriptionKey: 'homeWidgets.commuteDescription',
  Component: CommuteWidget,
  options: {
    defaults: DEFAULT_COMMUTE_SOURCE,
    parse: parseCommuteSource,
    summaryKey: (source) => `homeWidgets.source.${source.kind}`,
    Editor: CommuteOptions,
  },
};
