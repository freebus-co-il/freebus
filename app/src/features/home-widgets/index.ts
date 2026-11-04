/**
 * The home screen's widgets. Import from here, never from `./registry`
 * directly: this module is what registers the built-in widgets, so reading
 * the registry through it means they are always there.
 */
import './widgets';

export { homeWidget, homeWidgets, resolveOptions, type AnyHomeWidget, type HomeWidgetContext, type HomeWidgetDefinition } from './registry';
export { addToLayout, removeFromLayout } from './layout';
export { homeWidgetOptionsHref, RegisteredHomeWidget, useHomeLayout, useHomeWidgetOptions } from './use-home-widgets';
