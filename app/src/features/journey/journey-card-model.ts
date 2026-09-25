import type { TFunction } from 'i18next';

import type { Itinerary, TransitLeg } from '@/api/types';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import type { LegCard } from '@/features/trip/step-cards';

import { lineLabel, minutesLeft, stopName, vehicleInPlay } from './journey-labels';
import type { JourneyState } from './types';

/** `alert` is the get-off moment, and only that. */
export type JourneyCardTone = 'normal' | 'alert';

/** The three formatters this model needs, injected rather than imported.
 *
 *  `@/lib/format` reads the i18n singleton, which pulls in `react-native` and
 *  `expo-localization` -- neither of which `node --test` can load. Without
 *  injection, importing `@/lib/format` would make this module untestable.
 *  `journeyCopy` does import `@/lib/format` directly (and thus has no test
 *  file) -- it's a counter-example, not a precedent. Here, threading the
 *  formatters in keeps the module with the rules in it testable. */
export type JourneyCardFormat = {
  clock: (iso: string) => string;
  distance: (meters: number) => string;
  duration: (seconds: number) => string;
};

/**
 * One journey card, as facts rather than as views: a badge, a headline, one
 * supporting line, and whether the rider may say they are on a different run.
 *
 * Pure, and separate from the card that draws it, because this is the part
 * with rules in it -- the phase table in the spec -- and the app's test runner
 * has no renderer. Everything asserted about what the journey screen SAYS is
 * asserted here.
 */
export type JourneyCardModel = {
  /** The line, for a ride; null on a walk, which draws a walk glyph instead. */
  route: TransitLeg['route'] | null;
  headline: string;
  supporting: string | null;
  tone: JourneyCardTone;
  canSwitchLine: boolean;
};

/**
 * The spec's phase table, as a function.
 *
 * Keyed on the PHASE rather than on the leg's type: a ride card says something
 * different at a kerb than it does on board, and the difference is not in the
 * leg -- the leg is identical either way -- it is in what the rider has
 * already done.
 */
export function journeyCardModel(
  card: LegCard,
  state: JourneyState,
  itinerary: Itinerary,
  destinationLabel: string,
  t: TFunction,
  format: JourneyCardFormat,
): JourneyCardModel {
  // Off plan, no card is "in play": the legs after the one the rider fell off
  // are no longer the journey, and the screen replaces the card with the
  // off-plan card anyway.
  const onPlan = state.phase !== 'off-plan';
  const inPlay = onPlan && card.legIndex === state.legIndex;

  if (card.kind === 'walk') {
    const { leg } = card;
    const facts = t('journey.card.walkFacts', {
      duration: format.duration(leg.durationSeconds),
      distance: format.distance(leg.distanceMeters),
    });

    if (!inPlay) {
      return {
        route: null,
        headline: card.final ? destination(destinationLabel, t) : stopName(leg.to, t),
        supporting: facts,
        tone: 'normal',
        canSwitchLine: false,
      };
    }

    if (card.final) {
      return {
        route: null,
        headline: destination(destinationLabel, t),
        supporting:
          state.phase === 'arrived'
            ? t('journey.phase.arrived')
            // Minutes LEFT, not the walk's full length: a rider three minutes
            // into a five-minute walk is not still five minutes out.
            : t('journey.phase.arriving', { duration: format.duration(minutesLeft(state.timer) * 60) }),
        tone: 'normal',
        canSwitchLine: false,
      };
    }

    // A walk to a stop is racing a DEPARTURE, and the machine's timer already
    // counts to that departure rather than to the end of the walk. So the
    // supporting line is the deadline, not the distance -- the distance is
    // what the navigation banner above is already counting down.
    const ride = vehicleInPlay(itinerary, state);
    return {
      route: null,
      headline: stopName(leg.to, t),
      supporting: ride
        ? t('journey.card.catch', { line: lineLabel(ride), minutes: minutesLeft(state.timer) })
        : facts,
      tone: 'normal',
      canSwitchLine: false,
    };
  }

  const { leg } = card;

  if (!inPlay) {
    return {
      route: leg.route,
      headline: t('journey.card.boardAt', {
        name: stopName(leg.from.stop, t),
        time: format.clock(leg.from.departureTime),
      }),
      supporting: t('journey.card.offAt', {
        name: stopName(leg.to.stop, t),
        time: format.clock(leg.to.arrivalTime),
      }),
      tone: 'normal',
      // The rides still ahead, never one already behind: that bus has gone,
      // whichever line it was.
      canSwitchLine: onPlan && card.legIndex > state.legIndex,
    };
  }

  // A journey can end ON a ride: the API omits a zero-second egress walk, so
  // the machine sets `legIndex = legs.length - 1` with `leg: null` and
  // `timer: null` and the phase goes straight to `arrived` without ever
  // routing through the walk card's `card.final` branch above. Checked
  // BEFORE `alight-soon` and `riding` -- neither of those branches matches
  // `arrived`, and without this case the card fell through all the way to
  // the waiting branch below, printing `journey.nav.leavesIn` with
  // `minutesLeft(null)` -- "Leaves in 0 min" -- at the exact moment the
  // rider arrives. The overview card used to carry "You're here" for this
  // moment; with it gone, the ride card is what has to say it.
  if (state.phase === 'arrived') {
    return {
      route: leg.route,
      headline: t('journey.phase.arrived'),
      supporting: destination(destinationLabel, t),
      tone: 'normal',
      canSwitchLine: false,
    };
  }

  if (state.phase === 'alight-soon') {
    return {
      route: leg.route,
      headline: t('journey.phase.alightSoon'),
      supporting: stopName(leg.to.stop, t),
      tone: 'alert',
      // This window belongs to the alarm. Nothing else on the card.
      canSwitchLine: false,
    };
  }

  if (state.phase === 'riding') {
    return {
      route: leg.route,
      headline: stopName(leg.to.stop, t),
      // THE honesty rule (see `journey-copy.ts`): `stopsRemaining` is null
      // whenever no position has placed the rider on the route, and a stop
      // count is the one number these surfaces must never invent. With no fix
      // this drops to the time it can actually stand behind.
      supporting:
        state.stopsRemaining !== null
          ? t('journey.phase.riding', { count: state.stopsRemaining })
          : t('journey.phase.ridingUntil', { time: format.clock(leg.to.arrivalTime) }),
      tone: 'normal',
      canSwitchLine: true,
    };
  }

  // Waiting at the stop. The question here is never "how long" -- it is "is
  // this one mine?" -- so the supporting line answers that, with how far off
  // the bus is when a live position can say.
  const towards = leg.headsign.trim()
    ? t('results.towards', { name: formatHeadsign(leg.headsign) })
    : stopName(leg.from.stop, t);
  return {
    route: leg.route,
    headline: t('journey.nav.leavesIn', { minutes: minutesLeft(state.timer) }),
    // Composed through a locale key rather than a JS template literal: the
    // separator and the order are a translator's call, not this file's --
    // `journey.card.walkFacts` above does the same join the same way.
    supporting:
      state.busStopsAway !== null
        ? t('journey.card.towardsAndStops', {
            towards,
            stops: t('journey.nav.busStopsAway', { count: state.busStopsAway }),
          })
        : towards,
    tone: 'normal',
    canSwitchLine: true,
  };
}

function destination(label: string, t: TFunction): string {
  return label.trim() || t('journey.toDestination');
}
