import type { Itinerary, TransitLeg, WalkLeg } from '@/api/types';

import { buildTripSteps } from './build-trip-steps';
import type { JourneyState } from '@/features/journey/types';

/**
 * One swipe of the trip carousel.
 *
 * The first card is the whole journey; every card after it is ONE LEG, because
 * a leg is what the map can zoom to. That is the difference from
 * `buildTripSteps`, which models what the rider does: a wait has nowhere on
 * the map to show, so it rides along on the card of the ride it waits for,
 * and the arrival is the last card's own end time rather than a card of its
 * own.
 */
export type StepCard =
  | { kind: 'overview' }
  | {
      kind: 'walk';
      legIndex: number;
      leg: WalkLeg;
      startsAt: string;
      /** False on the last walk, which ends at the rider's destination. */
      final: boolean;
    }
  | {
      kind: 'ride';
      legIndex: number;
      leg: TransitLeg;
      /** The stand at the stop before boarding, when it is long enough to
       *  report (see `buildTripSteps`). */
      waitSeconds: number | null;
    };

export type LegCard = Exclude<StepCard, { kind: 'overview' }>;

export function buildStepCards(itinerary: Itinerary): StepCard[] {
  const cards: StepCard[] = [{ kind: 'overview' }];
  // Steps and legs run in the same order, so walking both with one cursor
  // pairs each walk/ride step with its leg without matching on content.
  let legIndex = 0;
  let pendingWait: number | null = null;

  for (const step of buildTripSteps(itinerary)) {
    if (step.kind === 'wait') {
      pendingWait = step.durationSeconds;
      continue;
    }
    if (step.kind === 'arrive') continue;

    const leg = itinerary.legs[legIndex]!;
    if (step.kind === 'walk' && leg.type === 'walk') {
      cards.push({ kind: 'walk', legIndex, leg, startsAt: step.startsAt, final: step.final });
    } else if (step.kind === 'ride' && leg.type === 'transit') {
      cards.push({ kind: 'ride', legIndex, leg, waitSeconds: pendingWait });
    }
    pendingWait = null;
    legIndex += 1;
  }
  return cards;
}

/** The leg a card puts in focus on the map; null for the whole journey. */
export function cardFocusLegIndex(card: StepCard | undefined): number | null {
  return card === undefined || card.kind === 'overview' ? null : card.legIndex;
}

/**
 * The card a running journey should be showing.
 *
 * Off-plan stays on the first card, which is where the way out lives -- the
 * legs after the one the rider fell off are no longer the journey.
 */
export function journeyCardIndex(cards: StepCard[], state: Pick<JourneyState, 'phase' | 'legIndex'>): number {
  if (state.phase === 'off-plan') return 0;
  const index = cards.findIndex((card) => card.kind !== 'overview' && card.legIndex === state.legIndex);
  return index === -1 ? 0 : index;
}
