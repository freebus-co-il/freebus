import type { TFunction } from 'i18next';

import type { Itinerary, TransitLeg } from '@/api/types';
import { formatHeadsign } from '@/features/results/itinerary-facts';

import type { JourneyState } from './types';

/**
 * The vehicle the surfaces should identify.
 *
 * While walking, `state.leg` is null -- but the rider is walking TOWARDS
 * something, and that something is the identity they need: the badge answers
 * "which line am I chasing", not "which line am I sitting on". Null on the
 * final walk and after arrival, where there is no vehicle left.
 */
export function vehicleInPlay(itinerary: Itinerary, state: JourneyState): TransitLeg | null {
  if (state.leg) return state.leg;
  for (const leg of itinerary.legs.slice(state.legIndex + 1)) {
    if (leg.type === 'transit') return leg;
  }
  return null;
}

/**
 * What to print where the copy says `{{line}}`.
 *
 * Falls back through the long name to the headsign because every one of this
 * feed's rail routes has an empty `shortName` -- the badge answers that with a
 * train glyph, but "{{line}} in 4 min" would be left saying " in 4 min".
 * For rail the API sends the final station as the headsign, so a train is
 * labelled by where it goes; its number (`tripNumber`) is deliberately not a
 * fallback here, since a bare "243 in 4 min" names nothing a rider can see.
 */
export function lineLabel(leg: TransitLeg): string {
  const named = [leg.route.shortName, leg.route.longName]
    .map((name) => name?.trim() ?? '')
    .find((name) => name !== '');
  return named ?? formatHeadsign(leg.headsign);
}

export function stopName(stop: { name?: string } | undefined, t: TFunction): string {
  return stop?.name?.trim() || t('trip.unnamedStop');
}

/**
 * Whole minutes left on the phase's own timer.
 *
 * Read off `state.timer` rather than a clock of the caller's own: the machine
 * stamps `from` with the instant it resolved the state, so the two ends of the
 * range are already consistent with each other. A second clock would drift
 * against it and show a minute the surfaces disagree about.
 */
export function minutesLeft(timer: JourneyState['timer']): number {
  if (!timer) return 0;
  return Math.max(0, Math.round((Date.parse(timer.to) - Date.parse(timer.from)) / 60_000));
}

/** The first ride after `legIndex`. */
export function nextTransitAfter(itinerary: Itinerary, legIndex: number): TransitLeg | null {
  for (const leg of itinerary.legs.slice(legIndex + 1)) {
    if (leg.type === 'transit') return leg;
  }
  return null;
}

/**
 * The line a divergence is about. A missed transfer is about the line being
 * CAUGHT -- "You'll miss the 142" -- which is the next ride, not the one the
 * rider is sitting on. Everything else is about the vehicle in play.
 */
export function offPlanLine(itinerary: Itinerary, state: JourneyState): TransitLeg | null {
  if (state.offPlan === 'missed-transfer') {
    return nextTransitAfter(itinerary, state.legIndex) ?? vehicleInPlay(itinerary, state);
  }
  return vehicleInPlay(itinerary, state);
}

/** The phases whose countdown runs to a DEPARTURE -- the only clock a live
 *  prediction moves. */
const DEPARTURE_COUNTDOWN_PHASES: ReadonlySet<JourneyState['phase']> = new Set(['walking-to-stop', 'waiting', 'transferring']);

/**
 * "Live" or "Scheduled" beside a departure countdown. Empty when the
 * deployment has no realtime at all, where labelling every time "scheduled"
 * would be noise (see `useRealtimeAvailable`), and on every phase whose clock
 * a prediction does not touch.
 */
export function liveLabelFor(state: JourneyState, realtimeAvailable: boolean, t: TFunction): string {
  if (!realtimeAvailable || !state.timer || !DEPARTURE_COUNTDOWN_PHASES.has(state.phase)) return '';
  return t(state.timeSource === 'live' ? 'journey.live.live' : 'journey.live.scheduled');
}
