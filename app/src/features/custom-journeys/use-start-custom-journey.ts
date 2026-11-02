import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';

import { apiGet } from '@/api/client';
import type { PlanResponse } from '@/api/types';
import { fetchWalk } from '@/api/walk';
import { useJourney } from '@/features/journey/journey-context';
import { placeLabel } from '@/lib/place';

import { planCustomJourney, StepUnplannableError } from './plan-custom-journey';
import type { CustomJourney } from './types';

/** A fresh fix gets this long; past it the journey starts from its first
 *  point, which is what the rider drew anyway. */
const FIX_TIMEOUT_MS = 4_000;
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
const LAST_KNOWN_ACCURACY_METERS = 150;

/**
 * Where the rider is, if the app may already know: never asks for the
 * permission (a tap on a journey is not the moment to open a system dialog;
 * the running journey asks for what it needs as any journey does).
 */
async function quietFix(): Promise<{ lat: number; lon: number } | null> {
  try {
    if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return null;
    const cached = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
      requiredAccuracy: LAST_KNOWN_ACCURACY_METERS,
    });
    if (cached) return { lat: cached.coords.latitude, lon: cached.coords.longitude };
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
    ]);
    return fresh ? { lat: fresh.coords.latitude, lon: fresh.coords.longitude } : null;
  } catch {
    return null;
  }
}

/**
 * Starts a saved journey: plans it from now (and from where the rider is),
 * hands it to the running journey like any other, and opens it. A running
 * journey is only replaced once the rider says so.
 */
export function useStartCustomJourney() {
  const { t, i18n } = useTranslation();
  const { journey: running, start } = useJourney();
  const [startingId, setStartingId] = useState<string | null>(null);

  const go = useCallback(async (saved: CustomJourney) => {
    setStartingId(saved.id);
    try {
      const position = await quietFix();
      const planned = await planCustomJourney({
        points: saved.points,
        position,
        nowMs: Date.now(),
        lang: i18n.language,
        fetchers: {
          plan: (query) => apiGet<PlanResponse>('/plan', { ...query }),
          walk: fetchWalk,
        },
      });
      await start(
        planned.itinerary,
        `custom:${saved.id}`,
        planned.itinerary.departureTime,
        planned.destinationLabel,
        { custom: { id: saved.id, name: saved.name } },
      );
      router.push('/journey');
    } catch (error) {
      const point = error instanceof StepUnplannableError ? saved.points[error.pointIndex] : undefined;
      Alert.alert(
        t('customJourney.startFailed'),
        point ? t('customJourney.startFailedStep', { name: placeLabel(point.place) }) : t('customJourney.startFailedGeneric'),
      );
    } finally {
      setStartingId(null);
    }
  }, [i18n.language, start, t]);

  const startJourney = useCallback((saved: CustomJourney) => {
    if (startingId !== null) return;
    if (running) {
      Alert.alert(t('journey.replace'), undefined, [
        { text: t('journey.keepGoing'), style: 'cancel' },
        { text: t('trip.start'), style: 'destructive', onPress: () => void go(saved) },
      ]);
      return;
    }
    void go(saved);
  }, [go, running, startingId, t]);

  return { startJourney, startingId };
}
