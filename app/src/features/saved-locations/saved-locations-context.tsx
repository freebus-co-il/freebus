import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { SelectedPlace } from '@/lib/place';

import type { LocationIconName, PresetId, SavedLocation } from './types';

const STORAGE_KEY = 'freebus.savedLocations.v1';

type CustomLocation = { id: string; label: string; icon: LocationIconName; place: SelectedPlace };

type StoredState = {
  presetPlaces: Record<PresetId, SelectedPlace | null>;
  customLocations: CustomLocation[];
};

const EMPTY_STATE: StoredState = {
  presetPlaces: { home: null, work: null },
  customLocations: [],
};

/** Parses whatever's in storage defensively -- a future format change or a
 *  half-written value (app killed mid-save) should degrade to "no saved
 *  locations yet", never crash the home screen on launch. */
function parseStoredState(raw: string | null): StoredState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw);
    return {
      presetPlaces: { home: parsed?.presetPlaces?.home ?? null, work: parsed?.presetPlaces?.work ?? null },
      customLocations: Array.isArray(parsed?.customLocations) ? parsed.customLocations : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

function useSavedLocationsState() {
  const { t } = useTranslation();
  const [state, setState] = useState<StoredState>(EMPTY_STATE);
  // Distinguishes "loaded, genuinely empty" from "haven't read storage yet" --
  // without this, the initial empty state would immediately overwrite
  // whatever's actually on disk the moment the save effect below first runs.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      setState(parseStoredState(raw));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, loaded]);

  function setPreset(id: PresetId, place: SelectedPlace) {
    setState((current) => ({ ...current, presetPlaces: { ...current.presetPlaces, [id]: place } }));
  }

  function addCustom(label: string, icon: LocationIconName, place: SelectedPlace) {
    const entry: CustomLocation = { id: `custom-${Date.now()}-${Math.round(Math.random() * 1e6)}`, label, icon, place };
    setState((current) => ({ ...current, customLocations: [...current.customLocations, entry] }));
  }

  function removeCustom(id: string) {
    setState((current) => ({ ...current, customLocations: current.customLocations.filter((l) => l.id !== id) }));
  }

  // Only the place changes here -- re-picking a location for an existing
  // custom entry keeps its title/icon exactly as they were, unlike `addCustom`
  // which creates a brand new one with all three.
  function updateCustomPlace(id: string, place: SelectedPlace) {
    setState((current) => ({
      ...current,
      customLocations: current.customLocations.map((l) => (l.id === id ? { ...l, place } : l)),
    }));
  }

  const locations: SavedLocation[] = [
    { id: 'home', label: t('savedLocations.home'), icon: 'home', place: state.presetPlaces.home, isPreset: true },
    { id: 'work', label: t('savedLocations.work'), icon: 'briefcase', place: state.presetPlaces.work, isPreset: true },
    ...state.customLocations.map((l): SavedLocation => ({ ...l, isPreset: false })),
  ];

  return { locations, setPreset, addCustom, removeCustom, updateCustomPlace };
}

type SavedLocationsContextValue = ReturnType<typeof useSavedLocationsState>;

const SavedLocationsContext = createContext<SavedLocationsContextValue | null>(null);

export function SavedLocationsProvider({ children }: { children: ReactNode }) {
  const value = useSavedLocationsState();
  return <SavedLocationsContext.Provider value={value}>{children}</SavedLocationsContext.Provider>;
}

export function useSavedLocations() {
  const ctx = useContext(SavedLocationsContext);
  if (!ctx) throw new Error('useSavedLocations must be used within a SavedLocationsProvider');
  return ctx;
}
