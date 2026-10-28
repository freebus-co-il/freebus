import { useColorScheme as useRNColorScheme } from 'react-native';

import { usePreferences } from '@/features/preferences/preferences-context';

/**
 * The colour scheme the app should actually paint in: the rider's override
 * when they set one, the device's own setting otherwise.
 *
 * Every themed surface reaches this through `useTheme`, and the root layout's
 * navigation `ThemeProvider` reads it directly, so overriding here is enough --
 * no screen needs to know the preference exists.
 */
export function useColorScheme() {
  const { themePreference } = usePreferences();
  const deviceScheme = useRNColorScheme();

  if (themePreference !== 'device') return themePreference;
  return deviceScheme;
}
