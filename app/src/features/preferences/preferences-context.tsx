import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales, useLocales } from 'expo-localization';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Appearance } from 'react-native';

import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@/features/journey/types';
import i18n from '@/i18n';
import { applyLayoutDirection, layoutMatchesLanguage, restartApp } from '@/i18n/direction';
import { setCurrentTimeFormat, type TimeFormat } from '@/lib/time-format';

import { isRTLLanguage, resolveLanguage, type LanguagePreference } from './resolve-language';

const STORAGE_KEY = 'freebus.preferences.v1';

/**
 * The direction a restart was last started FOR. A launch that comes back up
 * still laid out the wrong way, with this already set to the direction it
 * wants, gives up rather than restarting again -- one wasted restart, never a
 * loop that keeps the app behind its splash screen.
 */
const DIRECTION_RESTART_KEY = 'freebus.direction-restart.v1';

/** `device` defers to the OS setting and keeps following it if it changes. */
export type ThemePreference = 'device' | 'light' | 'dark';

/** `app` paints the map in whatever scheme the app is in; the other two pin
 *  it, for a rider who wants dark lists but a map they can read in the sun. */
export type MapStylePreference = 'app' | 'light' | 'dark';

type StoredState = {
  language: LanguagePreference;
  theme: ThemePreference;
  mapStyle: MapStylePreference;
  timeFormat: TimeFormat;
  alertSettings: AlertSettings;
  /** The journey on the Lock Screen (Live Activity) or in the shade (the
   *  ongoing notification), and the ride-time location that keeps it current.
   *  Off for a rider who finds it noisy or wants the battery; the get-off
   *  alarm does not depend on it. */
  liveSurface: boolean;
};

const DEFAULT_STATE: StoredState = {
  language: 'device',
  theme: 'device',
  mapStyle: 'app',
  timeFormat: 'countdown',
  alertSettings: DEFAULT_ALERT_SETTINGS,
  liveSurface: true,
};

/**
 * Field by field against the defaults rather than accepted or rejected whole,
 * because the overwhelmingly common "bad" blob here is a perfectly good one
 * written before the get-off alert existed: it has no `alertSettings` at all,
 * and the rider whose language it remembers must not lose it to a shape check.
 */
function parseAlertSettings(raw: unknown): AlertSettings {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const lead = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;

  return {
    leadStops: lead(stored.leadStops, DEFAULT_ALERT_SETTINGS.leadStops),
    leadSeconds: lead(stored.leadSeconds, DEFAULT_ALERT_SETTINGS.leadSeconds),
    sound: flag(stored.sound, DEFAULT_ALERT_SETTINGS.sound),
    vibrate: flag(stored.vibrate, DEFAULT_ALERT_SETTINGS.vibrate),
    repeatUntilAcknowledged: flag(
      stored.repeatUntilAcknowledged,
      DEFAULT_ALERT_SETTINGS.repeatUntilAcknowledged,
    ),
  };
}

/** Parsed defensively, like the saved-locations store: an unrecognised or
 *  half-written value should mean "follow the device", never crash on launch. */
function parseStoredState(raw: string | null): StoredState {
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw);
    return {
      language: ['device', 'he', 'en'].includes(parsed?.language) ? parsed.language : 'device',
      theme: ['device', 'light', 'dark'].includes(parsed?.theme) ? parsed.theme : 'device',
      mapStyle: ['app', 'light', 'dark'].includes(parsed?.mapStyle) ? parsed.mapStyle : 'app',
      timeFormat: ['countdown', 'clock'].includes(parsed?.timeFormat) ? parsed.timeFormat : 'countdown',
      alertSettings: parseAlertSettings(parsed?.alertSettings),
      liveSurface: typeof parsed?.liveSurface === 'boolean' ? parsed.liveSurface : true,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function usePreferencesState() {
  const [state, setState] = useState<StoredState>(DEFAULT_STATE);
  // Same reason as the saved-locations store: without this the initial default
  // state would overwrite whatever is really on disk the first time the save
  // effect runs.
  const [loaded, setLoaded] = useState(false);
  // Set only when a restart to fix the direction could not be started, or
  // already failed once: the app is shown anyway rather than held forever.
  const [directionGaveUp, setDirectionGaveUp] = useState(false);

  // A hook rather than a one-off read: the phone's language -- or, since the
  // app declares its locales, the per-app language in the OS settings -- can
  // change under a running app, and a "device default" rider follows it.
  const deviceLanguage = useLocales()[0]?.languageCode ?? undefined;
  const language = resolveLanguage(state.language, deviceLanguage);
  // The root layout holds the splash screen until this is true, so the app
  // never paints in the wrong language or laid out the wrong way.
  const directionSettled = layoutMatchesLanguage(language) || directionGaveUp;

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled) return;
        const stored = parseStoredState(raw);
        // Strings switched HERE, before `loaded` lets anything render, and not
        // only in the effect below: effects run after the first paint, which
        // would flash a frame of the device language under a stored override.
        const storedLanguage = resolveLanguage(stored.language, getLocales()[0]?.languageCode ?? undefined);
        if (i18n.language !== storedLanguage) i18n.changeLanguage(storedLanguage);
        setState(stored);
        setLoaded(true);
      })
      .catch(() => {
        // Never leave the app stuck behind the splash screen: a storage read
        // that fails still starts the app -- on device defaults, which is
        // exactly what an unreadable preferences file should mean.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, loaded]);

  // The ONE path from "which language" to strings and layout direction, for a
  // launch, a settings change and an OS language change alike. i18n was
  // initialised from the device locale at import, so this is also the moment a
  // stored override takes hold -- still behind the splash on a launch.
  useEffect(() => {
    if (!loaded) return;
    if (i18n.language !== language) i18n.changeLanguage(language);

    if (!applyLayoutDirection(language)) {
      AsyncStorage.removeItem(DIRECTION_RESTART_KEY);
      return;
    }

    // Laid out the wrong way: the flags now point the right way for the next
    // launch, so start it now rather than show a mirrored-the-wrong-way app.
    let cancelled = false;
    const target = isRTLLanguage(language) ? 'rtl' : 'ltr';
    (async () => {
      const attempted = await AsyncStorage.getItem(DIRECTION_RESTART_KEY).catch(() => null);
      if (cancelled) return;
      if (attempted !== target) {
        await AsyncStorage.setItem(DIRECTION_RESTART_KEY, target).catch(() => {});
        if (await restartApp()) return;
      } else {
        await AsyncStorage.removeItem(DIRECTION_RESTART_KEY).catch(() => {});
      }
      if (!cancelled) setDirectionGaveUp(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [language, loaded]);

  /**
   * Changing the language is a state update like any other; the effect above
   * swaps the strings and, when the direction flips, restarts the app -- which
   * `I18nManager` needs to take a new direction at all.
   */
  async function setLanguage(preference: LanguagePreference) {
    // Written through BEFORE the state update rather than left to the save
    // effect: a direction change restarts the app as soon as the update lands,
    // and a preference lost to that race would come back up in the old
    // language -- the most confusing possible outcome of tapping this row.
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, language: preference }));
    setState((current) => ({ ...current, language: preference }));
  }

  /**
   * The in-app light/dark choice, pushed down to the native layer so native
   * tabs, headers, sheets, menus, date pickers and Liquid Glass follow it
   * instead of the phone's setting. `'device'` hands control back.
   */
  useEffect(() => {
    if (!loaded) return;
    Appearance.setColorScheme(state.theme === 'device' ? 'unspecified' : state.theme);
  }, [loaded, state.theme]);

  function setTheme(preference: ThemePreference) {
    setState((current) => ({ ...current, theme: preference }));
  }

  function setMapStyle(preference: MapStylePreference) {
    setState((current) => ({ ...current, mapStyle: preference }));
  }

  /** Mirrored into `@/lib/time-format` for the code that runs outside React
   *  (scheduled notifications), during render so it is never a frame behind. */
  setCurrentTimeFormat(state.timeFormat);

  function setTimeFormat(preference: TimeFormat) {
    setState((current) => ({ ...current, timeFormat: preference }));
  }

  function setAlertSettings(next: AlertSettings) {
    setState((current) => ({ ...current, alertSettings: next }));
  }

  function setLiveSurface(next: boolean) {
    setState((current) => ({ ...current, liveSurface: next }));
  }

  return {
    loaded: loaded && directionSettled,
    language,
    languagePreference: state.language,
    themePreference: state.theme,
    mapStylePreference: state.mapStyle,
    timeFormat: state.timeFormat,
    alertSettings: state.alertSettings,
    liveSurface: state.liveSurface,
    setLanguage,
    setTheme,
    setMapStyle,
    setTimeFormat,
    setAlertSettings,
    setLiveSurface,
  };
}

type PreferencesContextValue = ReturnType<typeof usePreferencesState>;

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const value = usePreferencesState();
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within a PreferencesProvider');
  return ctx;
}
