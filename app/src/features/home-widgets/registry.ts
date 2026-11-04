import type { ComponentType } from 'react';

import type { IconName } from '@/design-system';
import type { SelectedPlace } from '@/lib/place';

import { createRegistry, resolveOptions } from './registry-store';

/**
 * The home screen's widgets are plugins: each one is a definition handed to
 * `registerHomeWidget` (see `widgets/index.ts`), and everything else follows
 * from the registry. The home screen draws what is registered, the Home
 * screen editor lists it, its options open on the one generic options page
 * (`app/settings/home-widget/[id].tsx`), and its options are stored under its
 * id. Adding a widget is a folder and one `registerHomeWidget` line; no
 * screen, route or preference field has to learn about it.
 */

/** What the home screen hands every widget. */
export type HomeWidgetContext = {
  /** The ids on the page, top to bottom, so a widget can step aside for
   *  another one (the commute card does not repeat the nearby map). */
  layout: readonly string[];
  /** Plans a trip to a place, the way a saved-place chip does. */
  onSelectDestination: (place: SelectedPlace) => void;
};

/**
 * A widget's own settings. Stored as whatever `parse` reads back, under the
 * widget's id, so a widget's options can change shape without the preferences
 * store knowing: `parse` is where a stored value from an older build is
 * brought up to date, and anything it cannot read becomes `defaults`.
 */
export type HomeWidgetOptions<O> = {
  defaults: O;
  parse: (raw: unknown) => O;
  /** The i18n key naming the current choice, shown on the widget's row in the
   *  Home screen editor ("Map and list", "There and back"). */
  summaryKey: (options: O) => string;
  /** The options page's sections, drawn inside the generic settings page,
   *  which supplies the header and the scrolling. */
  Editor: ComponentType<{ value: O; onChange: (next: O) => void }>;
};

export type HomeWidgetDefinition<O = undefined> = {
  /** Stable forever: it keys the stored layout and the stored options. */
  id: string;
  icon: IconName;
  titleKey: string;
  descriptionKey: string;
  /** On the page for a rider who has never opened the editor. */
  defaultOn?: boolean;
  Component: ComponentType<{ options: O; context: HomeWidgetContext }>;
  options?: HomeWidgetOptions<O>;
};

// Erased at the boundary: each definition is checked against its own `O` when
// it is registered, and only ever read back with its own options.
export type AnyHomeWidget = HomeWidgetDefinition<any>;

const registry = createRegistry<AnyHomeWidget>('Home widget');

export function registerHomeWidget<O>(widget: HomeWidgetDefinition<O>): void {
  registry.register(widget);
}

/** Every registered widget, in the order they were registered. */
export const homeWidgets = registry.list;

export const homeWidget = registry.get;

export { resolveOptions };
