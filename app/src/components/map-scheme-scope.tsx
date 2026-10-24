import { useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';

import { SchemeScope } from '@/design-system';
import { useMapScheme } from '@/hooks/use-map-appearance';

/**
 * Paints a map and everything on it in the map's scheme (see `useMapScheme`):
 * markers, the credit pill, and the glass chrome floating over it. Glass
 * takes its brightness from what is behind it, so a dark-mode control over a
 * map pinned light ends up white text on a light pill.
 *
 * `screen` is for a full-bleed map screen, where the status bar sits on the
 * map too. Only while focused: a screen pushed over this one still has it
 * mounted, and would otherwise inherit its status bar.
 */
export function MapSchemeScope({ screen = false, children }: { screen?: boolean; children: ReactNode }) {
  const scheme = useMapScheme();
  const focused = useIsFocused();
  return (
    <SchemeScope scheme={scheme}>
      {screen && focused && <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />}
      {children}
    </SchemeScope>
  );
}
