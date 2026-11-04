import type { Href } from 'expo-router';

import { usePreferences } from '@/features/preferences/preferences-context';

import { resolveLayout } from './layout';
import { homeWidget, homeWidgets, resolveOptions, type AnyHomeWidget, type HomeWidgetContext, type HomeWidgetDefinition } from './registry';

/** The rider's layout as registered widgets, top to bottom, and the way to
 *  change it. Ids nothing registers are left out. */
export function useHomeLayout(): { widgets: AnyHomeWidget[]; ids: string[]; setIds: (next: string[]) => void } {
  const { homeLayout, setHomeLayout } = usePreferences();
  const registered = homeWidgets();
  const ids = resolveLayout(
    homeLayout,
    registered.map((widget) => widget.id),
    registered.filter((widget) => widget.defaultOn).map((widget) => widget.id),
  );
  return { widgets: ids.map((id) => homeWidget(id)!), ids, setIds: setHomeLayout };
}

/** One widget's options, read through the widget, and the way to save them. */
export function useHomeWidgetOptions<O>(widget: HomeWidgetDefinition<O>): [O, (next: O) => void] {
  const { homeWidgetOptions, setHomeWidgetOptions } = usePreferences();
  return [resolveOptions(widget, homeWidgetOptions), (next) => setHomeWidgetOptions(widget.id, next)];
}

/** Where a widget's options open: the one page every widget shares. */
export function homeWidgetOptionsHref(id: string): Href {
  return { pathname: '/settings/home-widget/[id]', params: { id } };
}

/** A registered widget on the home screen, with its own options. */
export function RegisteredHomeWidget({ widget, context }: { widget: AnyHomeWidget; context: HomeWidgetContext }) {
  const [options] = useHomeWidgetOptions(widget);
  const { Component } = widget;
  return <Component options={options} context={context} />;
}
