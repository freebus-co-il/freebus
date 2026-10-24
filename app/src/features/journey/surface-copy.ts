import type { TFunction } from 'i18next';

import type { Itinerary, TransitLeg } from '@/api/types';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { routeColor } from '@/lib/route-color';

import type { JourneyCopy } from './journey-copy';
import { lineLabel, stopName, vehicleInPlay } from './journey-labels';
import type { JourneyState } from './types';

/**
 * The ride the rider is on, as the lock screen draws it: one dot per stop,
 * the ones behind them filled.
 *
 * `passed` is null whenever no fix has placed the rider on the route. The
 * strip then fills by TIME between `from` and `to`, which the OS animates on
 * its own and which is labelled as scheduled, rather than a stop count the app
 * cannot stand behind.
 */
export type SurfaceRide = {
  /** Stops to ride, the alight stop included. */
  stops: number;
  passed: number | null;
  /** The word under the big stop count, pluralised for what is left. */
  stopsLabel: string;
  /** The leg's departure and arrival, for the strip's time fill. */
  from: string;
  to: string;
};

/**
 * The words a live surface prints, resolved on this side of the bridge.
 *
 * A `JourneyState` carries facts and no prose, so a renderer handed only the
 * state has to invent its own, which is how the Android module once ended up
 * with a second copy of the `journey.*` keys in `strings.xml`, free to drift
 * from the JSON the rest of the app reads. `react-i18next` lives here and only
 * here; the surfaces are handed the finished sentences.
 *
 * The lock screen answers two questions, and says different things for each.
 * At the stop: is my bus coming, and when? On the bus: when do I get off? So
 * the waiting hero is the direction (the badge already names the line), and
 * the riding hero is the stop to get off at, with the next stop beneath it.
 *
 * Nothing here carries a ticking minute: the surfaces render their own
 * countdown from a date range the OS animates, so a sentence with a minute in
 * it would both cost an update a minute and freeze the moment the app
 * suspends.
 */
export type JourneySurfaceCopy = {
  hero: string;
  supporting: string | null;
  accent: string;
  /**
   * "Get off" in one word, for the slot beside the camera, which is about 46pt
   * wide: room for a clock or a glyph and nothing like room for the
   * `alight-soon` hero.
   */
  alightNow: string;
  /** "Live" / "Scheduled" beside the countdown, already translated; empty
   *  when there is nothing to label. */
  liveLabel: string;
  /**
   * What the countdown counts to, over it: "Departs in", "Arrives in". A
   * bare `4:12` on a lock screen that also shows `11:07` reads as a time of
   * day; the label is what makes it a duration. Empty when the big slot is
   * not a countdown.
   */
  countdownLabel: string;
  /** While waiting: the later rides from the same stop that also get there,
   *  "Then: 480 14:22 · 852 14:30". Null when there are none. */
  then: string | null;
  ride: SurfaceRide | null;
  /**
   * The colour of the line in play, as `#rrggbb`, theme-independent (unlike
   * `accent`). Sent on every update rather than only at start: a surface that
   * outlived the app's process has nothing else to colour its badge from.
   * Empty when no line is in play.
   */
  routeColor: string;
  /** The app's reading direction, which the widget lays itself out in. The
   *  phone's own language decides nothing here: the words are the app's. */
  rtl: boolean;
};

/** Injected rather than imported: `@/lib/format` reads the i18n singleton,
 *  which `node --test` cannot load. See `JourneyCardFormat`. */
export type SurfaceFormat = { clock: (iso: string) => string; rtl: boolean };

/** How many later rides the waiting surface lists. Two fit one line in Hebrew
 *  at caption size; a third would truncate. */
export const THEN_RIDES = 2;

/** Stops to ride on `leg`, the alight stop included. */
export function stopsToRide(leg: TransitLeg): number {
  return Math.max(1, leg.numStops || leg.intermediateStops.length + 1);
}

function thenLine(leg: TransitLeg, departure: string, format: SurfaceFormat, t: TFunction): string | null {
  const after = Date.parse(departure);
  const rides = (leg.alternatives ?? [])
    .filter((ride) => !ride.missesConnection && Date.parse(ride.from.departureTime) > after)
    .sort((a, b) => Date.parse(a.from.departureTime) - Date.parse(b.from.departureTime))
    .slice(0, THEN_RIDES)
    .map((ride) => `${lineLabel(ride)} ${format.clock(ride.from.departureTime)}`);
  return rides.length > 0 ? t('journey.surface.then', { rides: rides.join(' · ') }) : null;
}

/**
 * The in-app copy, narrowed and reshaped for an OS surface.
 *
 * Starts from `heroStatic` (never `hero`, which has a ticking minute in it) and
 * overrides the phases the lock screen answers differently from the app.
 */
export function surfaceCopy(
  copy: JourneyCopy,
  state: JourneyState,
  itinerary: Itinerary,
  t: TFunction,
  format: SurfaceFormat,
  liveLabel = '',
): JourneySurfaceCopy {
  const base: JourneySurfaceCopy = {
    hero: copy.heroStatic,
    supporting: copy.supporting,
    accent: copy.accent,
    alightNow: t('journey.phase.alightSoonCompact'),
    liveLabel,
    countdownLabel: '',
    then: null,
    ride: null,
    rtl: format.rtl,
    routeColor: (() => {
      const vehicle = vehicleInPlay(itinerary, state);
      return vehicle ? routeColor(vehicle.route) : '';
    })(),
  };

  if (state.offPlan || state.phase === 'arrived') return base;

  const leg = state.leg;

  if (leg && state.phase === 'waiting') {
    const headsign = formatHeadsign(leg.headsign);
    return {
      ...base,
      hero: headsign ? t('results.towards', { name: headsign }) : lineLabel(leg),
      supporting: t('journey.surface.fromStop', { name: stopName(leg.from.stop, t) }),
      countdownLabel: t('journey.surface.departsIn'),
      then: thenLine(leg, state.timer?.to ?? leg.from.departureTime, format, t),
    };
  }

  if (leg && (state.phase === 'riding' || state.phase === 'alight-soon')) {
    const stops = stopsToRide(leg);
    const remaining = state.stopsRemaining;
    const passed = remaining === null ? null : Math.min(stops, Math.max(0, stops - remaining));
    const ride: SurfaceRide = {
      stops,
      passed,
      stopsLabel: t('journey.surface.stops', { count: remaining ?? stops }),
      from: leg.from.departureTime,
      to: leg.to.arrivalTime,
    };
    const alightAt = stopName(leg.to.stop, t);

    if (state.phase === 'alight-soon') {
      return { ...base, supporting: alightAt, ride };
    }

    if (remaining === null) {
      // No position: the big slot is the arrival countdown, and it says so.
      return {
        ...base,
        hero: t('journey.surface.getOffAt', { name: alightAt }),
        supporting: t('journey.surface.arrivesAt', { time: format.clock(leg.to.arrivalTime) }),
        countdownLabel: t('journey.surface.arrivesIn'),
        liveLabel: t('journey.live.scheduled'),
        ride,
      };
    }

    return {
      ...base,
      hero: t('journey.surface.getOffAt', { name: alightAt }),
      supporting: state.nextStopName ? t('journey.surface.nextStop', { name: state.nextStopName }) : null,
      ride,
    };
  }

  if (state.phase === 'transferring') {
    const ride = vehicleInPlay(itinerary, state);
    return {
      ...base,
      hero: ride ? t('journey.surface.transferTo', { line: lineLabel(ride) }) : base.hero,
      countdownLabel: t('journey.surface.departsIn'),
    };
  }

  if (state.phase === 'walking-to-stop') {
    return { ...base, countdownLabel: t('journey.surface.departsIn') };
  }

  if (state.phase === 'arriving') {
    return { ...base, countdownLabel: t('journey.surface.arrivesIn') };
  }

  return base;
}
