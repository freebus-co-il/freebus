import { registerHomeWidget } from '../registry';

import { commuteWidget } from './commute';
import { nearbyWidget } from './nearby';

/**
 * Every widget the home screen can show, in the order the editor offers them.
 * A new widget is its own folder here, exporting a `HomeWidgetDefinition`,
 * and one line below; the home screen, the Home screen editor and the
 * options page pick it up from the registry.
 */
registerHomeWidget(nearbyWidget);
registerHomeWidget(commuteWidget);
