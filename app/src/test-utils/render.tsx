import { render as rtlRender } from '@testing-library/react-native';
import { renderRouter as expoRenderRouter, type MockContextConfig } from 'expo-router/testing-library';
import type { ReactElement, ReactNode } from 'react';

import { PreferencesProvider } from '@/features/preferences/preferences-context';

function Providers({ children }: { children: ReactNode }) {
  return <PreferencesProvider>{children}</PreferencesProvider>;
}

/** Renders a component inside the app's own providers, so design-system
 *  components get their theme the same way they do on device. */
export function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: Providers });
}

/** Renders a route the way the app does: inside expo-router (for headers and
 *  navigation) and the app's providers. `routes` maps a path to its screen. */
export function renderRouter(routes: MockContextConfig, initialUrl: string) {
  return expoRenderRouter(routes, { initialUrl, wrapper: Providers });
}

export { fireEvent, screen } from '@testing-library/react-native';
