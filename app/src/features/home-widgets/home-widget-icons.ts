import type { IconName } from '@/design-system';

import type { HomeWidgetId } from './widgets';

/** Each widget's glyph in the home screen editor. */
export const HOME_WIDGET_ICONS: Record<HomeWidgetId, IconName> = {
  nearby: 'stations',
  commute: 'work',
};
