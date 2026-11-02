import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { newCustomJourneyId, type CustomJourney, type JourneyPoint } from './types';

const STORAGE_KEY = 'freebus.customJourneys.v1';

/** Parsed defensively, like the saved locations: a half-written or
 *  older-shaped value means "no journeys yet", never a crash on launch. A
 *  journey whose points do not read back is dropped rather than kept broken. */
export function parseStoredJourneys(raw: string | null): CustomJourney[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((each): each is CustomJourney =>
      typeof each?.id === 'string'
      && typeof each?.name === 'string'
      && Array.isArray(each?.points)
      && each.points.every((point: Partial<JourneyPoint>) => typeof point?.id === 'string' && typeof point?.place?.kind === 'string'));
  } catch {
    return [];
  }
}

function useCustomJourneysState() {
  const [journeys, setJourneys] = useState<CustomJourney[]>([]);
  // Distinguishes "loaded, genuinely empty" from "not read yet", so the
  // first save cannot overwrite what is on disk with the empty start.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!cancelled) setJourneys(parseStoredJourneys(raw));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(journeys)).catch(() => {
      // Kept in memory for the session; the next change tries again.
    });
  }, [journeys, loaded]);

  /** Adds a journey, or replaces the one with the same id. Returns its id. */
  const save = useCallback((journey: Omit<CustomJourney, 'id' | 'createdAt'> & { id?: string }): string => {
    const id = journey.id ?? newCustomJourneyId();
    setJourneys((current) => {
      const existing = current.find((each) => each.id === id);
      const next: CustomJourney = {
        id,
        name: journey.name,
        points: journey.points,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      return existing ? current.map((each) => (each.id === id ? next : each)) : [...current, next];
    });
    return id;
  }, []);

  const remove = useCallback((id: string) => {
    setJourneys((current) => current.filter((each) => each.id !== id));
  }, []);

  const find = useCallback((id: string | null | undefined) => journeys.find((each) => each.id === id) ?? null, [journeys]);

  return useMemo(() => ({ journeys, loaded, save, remove, find }), [journeys, loaded, save, remove, find]);
}

type CustomJourneysContextValue = ReturnType<typeof useCustomJourneysState>;

const CustomJourneysContext = createContext<CustomJourneysContextValue | null>(null);

export function CustomJourneysProvider({ children }: { children: ReactNode }) {
  const value = useCustomJourneysState();
  return <CustomJourneysContext.Provider value={value}>{children}</CustomJourneysContext.Provider>;
}

export function useCustomJourneys() {
  const ctx = useContext(CustomJourneysContext);
  if (!ctx) throw new Error('useCustomJourneys must be used within a CustomJourneysProvider');
  return ctx;
}
