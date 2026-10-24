import '@/global.css';
import '@/i18n';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ShareIntentProvider } from 'expo-share-intent';

import { JourneyProvider } from '@/features/journey/journey-context';
import { LeaveReminderGate } from '@/features/journey/leave-reminder-gate';
import { UpdateSnackbar } from '@/features/updates/update-snackbar';
import { JourneyPip } from '@/features/journey/journey-pip';
import { usePip } from '@/features/journey/pip';
import { PreferencesProvider, usePreferences } from '@/features/preferences/preferences-context';
import { RecentsProvider } from '@/features/recents/recents-context';
import { SavedLocationsProvider } from '@/features/saved-locations/saved-locations-context';
import { SearchProvider } from '@/features/search/search-context';
import { ShareIntentGate } from '@/features/share-intent/share-intent-gate';
import { Palettes } from '@/design-system';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { initAnalytics } from '@/lib/analytics';

const queryClient = new QueryClient();

/** The navigator's own colours, from the design system's roles, so native
 *  headers, screen backgrounds and transitions match the pages. */
function navigationTheme(scheme: 'light' | 'dark') {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const c = Palettes[scheme];
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: c.accent,
      background: c.bgGrouped,
      card: c.bgGrouped,
      text: c.textPrimary,
      border: c.separator,
      notification: c.danger,
    },
  };
}

// A share (or a tapped `geo:` link) can launch the app straight onto `/share`,
// which is a transient screen that replaces itself with a trip. Naming the
// tabs as this stack's anchor is what puts the home screen underneath it on a
// cold start, so backing out of the trip that share produced goes home
// instead of failing with nothing left on the stack.
export const unstable_settings = { anchor: '(tabs)' };

// Held until the stored preferences are read. Language and layout direction are
// applied from them before anything paints, so the app never flashes the device
// language and then swaps -- and never has to reload itself just to get the
// direction right on a normal launch.
SplashScreen.preventAutoHideAsync();

// Release builds only, one event per open, no properties -- see the module.
initAnalytics();

/** Everything that needs to know the rider's preferences, which is to say
 *  everything -- this exists only because it must sit INSIDE the provider. */
function App() {
  const { loaded } = usePreferences();
  const colorScheme = useColorScheme();
  const { inPip } = usePip();

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <ThemeProvider value={navigationTheme(colorScheme === 'dark' ? 'dark' : 'light')}>
      {/* Explicit, never `auto`: `auto` follows the PHONE's scheme, so a dark
          phone with the app set to light gets light icons on a light page. */}
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <SearchProvider>
        <SavedLocationsProvider>
          <RecentsProvider>
            {/* Above the navigator, not inside it: a running journey outlives the
                screen that started it, so nothing about it may be owned by a
                route the rider can pop. */}
            <JourneyProvider>
              {/* Inside the navigator's providers but outside the navigator:
                  it navigates, and renders nothing. */}
              <ShareIntentGate />
              {/* Beside it, and for the same reason: a tapped leave reminder
                  arrives from the OS, not as a URL, so something mounted has
                  to notice and start the journey it names. */}
              <LeaveReminderGate />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" />
                {/* Root-level, NOT inside the tab group: these push OVER the tab
                    bar. The results screen's draggable sheet reaches the bottom of
                    the display, which a persistent tab bar would sit on top of. */}
                {/* From the home screen's search capsule the picker's field grows
                    out of the capsule (see `search-morph`); from everywhere else
                    it slides up. */}
                <Stack.Screen
                  name="location-picker"
                  options={({ route }) =>
                    (route.params as { morph?: string } | undefined)?.morph === '1'
                      ? // Transparent and unanimated: the home screen stays
                        // visible underneath while the picker fades its own
                        // page in behind the morphing glass.
                        { presentation: 'transparentModal', animation: 'none' }
                      : { animation: 'slide_from_bottom' }
                  }
                />
                {/* Pushed from the home screen or over the picker. No edge swipe
                    back: a drag starting at the screen's edge is the rider
                    panning the map. */}
                <Stack.Screen name="map-picker" options={{ gestureEnabled: false }} />
                <Stack.Screen name="save-location" options={{ animation: 'slide_from_bottom' }} />
                <Stack.Screen name="about" />
                {/* The Settings tab's pages, pushed over the tab bar like `about`. */}
                <Stack.Screen name="settings/language" />
                <Stack.Screen name="settings/appearance" />
                <Stack.Screen name="settings/alerts" />
                {/* Same reasoning, plus one of its own: the journey screen is what
                    the docked bar EXPANDS into, so it has to cover the bar. */}
                <Stack.Screen name="journey" options={{ animation: 'slide_from_bottom' }} />
                {/* Reads a location shared from another app, then replaces
                    itself with the trip it describes. */}
                <Stack.Screen name="share" options={{ animation: 'fade' }} />
              </Stack>
              {/* Over the navigator, not instead of it: navigation state
                  survives the round trip through the PiP window. */}
              {inPip && <JourneyPip />}
              {/* Over the navigator, so it floats above whatever screen is
                  showing instead of taking a row in one. Renders nothing
                  until an update is downloaded. */}
              <UpdateSnackbar />
            </JourneyProvider>
          </RecentsProvider>
        </SavedLocationsProvider>
      </SearchProvider>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    // Required by `react-native-gesture-handler` v2 (the results screen's
    // draggable bottom sheet uses its Gesture API) -- without this wrapper
    // gestures silently fail to recognize touches on iOS/Android.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Above every other provider, as `expo-share-intent` requires: on a
          cold start launched by a share, the payload has to be picked up
          before anything below here decides what to render. */}
      <ShareIntentProvider>
        <QueryClientProvider client={queryClient}>
          <PreferencesProvider>
            <App />
          </PreferencesProvider>
        </QueryClientProvider>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
