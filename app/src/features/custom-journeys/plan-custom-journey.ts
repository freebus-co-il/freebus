import type { Itinerary, Leg, PlanQuery, PlanResponse, Place, WalkLeg, WalkRouteResponse } from '@/api/types';
import { haversineMeters } from '@/lib/geo';
import { placeCoordinates, placeLabel, placeToQueryValue, type SelectedPlace } from '@/lib/place';

import type { JourneyPoint, PointVia } from './types';

/**
 * A saved journey becomes an ordinary itinerary at Start: each step between
 * two pinned points is planned on its own, from where the step before left
 * the rider and no earlier than when, and the steps are laid end to end. The
 * running journey then treats it like any other, station by station, so at
 * each pinned station the board offers every run that makes the next step.
 *
 * Pure apart from the two fetchers it is handed, so it is tested without a
 * network.
 */

/** GTFS route types for "by train": heavy and light rail. */
const TRAIN_MODES = '0,1,2,12';
/** GTFS route types for "by bus", demand-responsive lines included. */
const BUS_MODES = '3,11,715';

export function modesFor(via: PointVia): string | undefined {
  if (via === 'train') return TRAIN_MODES;
  if (via === 'bus') return BUS_MODES;
  return undefined;
}

/** A rider this close to the first point is starting there: plan from the
 *  fix, which may already be down the street at the stop. */
export const NEAR_FIRST_POINT_METERS = 1500;
/** A rider this close to a later point has already come that far (they
 *  started the journey at the station, not at home): start from there. */
export const AT_POINT_METERS = 300;
/** The walking pace the app assumes everywhere else, for a walk the street
 *  router could not draw. */
const WALK_METERS_PER_SECOND = 1.2;
const WALK_DETOUR = 1.3;

/** How many ways to ask the planner for per step: enough to choose the
 *  soonest arrival from, few enough to stay cheap on a small box. */
const STEP_RESULTS = 3;

export type Fetchers = {
  plan: (query: PlanQuery & { results: number }) => Promise<PlanResponse>;
  walk: (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => Promise<WalkRouteResponse>;
};

export class StepUnplannableError extends Error {
  /** Index of the point the step leads INTO. */
  readonly pointIndex: number;
  constructor(pointIndex: number) {
    super(`No way found to point ${pointIndex}`);
    this.pointIndex = pointIndex;
  }
}

type Position = { lat: number; lon: number };

/**
 * Which point the journey starts from, and whether from the rider's fix.
 *
 * The furthest point (other than the last) the rider is standing at wins, so
 * a journey home started on the platform starts on the platform. Otherwise a
 * rider near the first point starts from where they are; anyone else starts
 * from the first point, as the rider drew it.
 */
export function startFor(points: readonly JourneyPoint[], position: Position | null): { index: number; fromFix: boolean } {
  if (!position) return { index: 0, fromFix: false };
  for (let index = points.length - 2; index >= 1; index -= 1) {
    const at = placeCoordinates(points[index]!.place);
    if (at && haversineMeters(at, position) <= AT_POINT_METERS) return { index, fromFix: true };
  }
  const first = placeCoordinates(points[0]!.place);
  if (first && haversineMeters(first, position) <= NEAR_FIRST_POINT_METERS) return { index: 0, fromFix: true };
  return { index: 0, fromFix: false };
}

function toPlace(place: SelectedPlace): Place | null {
  const at = placeCoordinates(place);
  if (!at) return null;
  return place.kind === 'stop'
    ? { type: 'stop', lat: at.lat, lon: at.lon, stopId: place.stopId, name: place.name }
    : { type: 'coordinate', lat: at.lat, lon: at.lon, name: place.label };
}

function walkLeg(from: Place, to: Place, route: WalkRouteResponse | null): WalkLeg {
  if (route) {
    return {
      type: 'walk', from, to,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      walkEstimated: route.estimated || route.geometry === null,
      steps: route.steps,
    };
  }
  const distanceMeters = Math.round(haversineMeters(from, to) * WALK_DETOUR);
  return {
    type: 'walk', from, to, distanceMeters,
    durationSeconds: Math.round(distanceMeters / WALK_METERS_PER_SECOND),
    geometry: null,
    walkEstimated: true,
  };
}

/**
 * Two walks back to back (the end of one step and the start of the next,
 * around a pinned place) become one: the journey has no use for a step
 * boundary nobody stops at, and the street router redraws it from the rider's
 * fix once they are walking it.
 */
export function mergeWalks(legs: readonly Leg[]): Leg[] {
  const merged: Leg[] = [];
  for (const leg of legs) {
    const last = merged[merged.length - 1];
    if (leg.type === 'walk' && last?.type === 'walk') {
      merged[merged.length - 1] = {
        type: 'walk',
        from: last.from,
        to: leg.to,
        distanceMeters: last.distanceMeters + leg.distanceMeters,
        durationSeconds: last.durationSeconds + leg.durationSeconds,
        geometry: null,
        walkEstimated: true,
      };
      continue;
    }
    // A walk of nothing (a step planned from the very stop the last one ended
    // at) is no step at all.
    if (leg.type === 'walk' && leg.distanceMeters < 1 && leg.durationSeconds < 1) continue;
    merged.push(leg);
  }
  return merged;
}

/** The steps laid end to end, as one itinerary with honest totals. */
export function stitch(steps: readonly { legs: readonly Leg[]; departureMs: number; arrivalMs: number; atRisk: boolean | null }[]): Itinerary {
  const legs = mergeWalks(steps.flatMap((step) => step.legs));
  const departureMs = steps[0]?.departureMs ?? Date.now();
  const arrivalMs = steps[steps.length - 1]?.arrivalMs ?? departureMs;
  const walks = legs.filter((leg): leg is WalkLeg => leg.type === 'walk');
  const rides = legs.filter((leg) => leg.type === 'transit').length;
  return {
    departureTime: new Date(departureMs).toISOString(),
    arrivalTime: new Date(arrivalMs).toISOString(),
    durationSeconds: Math.round((arrivalMs - departureMs) / 1000),
    transfers: Math.max(0, rides - 1),
    walkSeconds: walks.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    walkMeters: walks.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    legs,
    transferAtRisk: steps.some((step) => step.atRisk === true) ? true : steps.every((step) => step.atRisk === false) ? false : null,
  };
}

function soonest(itineraries: readonly Itinerary[]): Itinerary | null {
  return itineraries.reduce<Itinerary | null>(
    (best, each) => (best === null || Date.parse(each.arrivalTime) < Date.parse(best.arrivalTime) ? each : best),
    null,
  );
}

export type PlannedCustomJourney = {
  itinerary: Itinerary;
  /** The label the running journey names its destination by. */
  destinationLabel: string;
  /** Index of the point the journey started from. */
  startIndex: number;
};

/**
 * Plans a saved journey from now. Each step departs no earlier than the step
 * before arrives; a step no vehicle makes (late at night, on Shabbat) fails
 * the whole plan with the point it could not reach, so the rider is told
 * which part of their journey has no service rather than given half of one.
 */
export async function planCustomJourney(args: {
  points: readonly JourneyPoint[];
  position: Position | null;
  nowMs: number;
  lang: string;
  fetchers: Fetchers;
}): Promise<PlannedCustomJourney> {
  const { points, position, nowMs, lang, fetchers } = args;
  if (points.length < 2) throw new StepUnplannableError(1);
  const start = startFor(points, position);

  type Step = { legs: Leg[]; departureMs: number; arrivalMs: number; atRisk: boolean | null };
  const steps: Step[] = [];
  let cursorMs = nowMs;
  let fromPlace: SelectedPlace | null = start.fromFix ? null : points[start.index]!.place;
  let fromFix: Position | null = start.fromFix ? position : null;

  for (let index = start.index + 1; index < points.length; index += 1) {
    const point = points[index]!;
    const fromQuery = fromFix ? `${fromFix.lat},${fromFix.lon}` : placeToQueryValue(fromPlace!);
    const fromAsPlace: Place | null = fromFix
      ? { type: 'coordinate', lat: fromFix.lat, lon: fromFix.lon }
      : toPlace(fromPlace!);
    const toAsPlace = toPlace(point.place);

    if (point.via === 'walk' && fromAsPlace && toAsPlace) {
      let route: WalkRouteResponse | null = null;
      try {
        route = await fetchers.walk(fromAsPlace, toAsPlace);
      } catch {
        route = null;
      }
      const leg = walkLeg(fromAsPlace, toAsPlace, route);
      steps.push({ legs: [leg], departureMs: cursorMs, arrivalMs: cursorMs + leg.durationSeconds * 1000, atRisk: false });
      cursorMs += leg.durationSeconds * 1000;
    } else {
      const modes = modesFor(point.via);
      let response: PlanResponse;
      try {
        response = await fetchers.plan({
          from: fromQuery,
          to: placeToQueryValue(point.place),
          departAfter: new Date(cursorMs).toISOString(),
          lang,
          results: STEP_RESULTS,
          ...(modes ? { modes } : {}),
        });
      } catch {
        throw new StepUnplannableError(index);
      }
      const best = soonest(response.itineraries);
      if (!best) throw new StepUnplannableError(index);
      // The planner's departure is the latest the rider can leave the door
      // and still make it; never before the step before has arrived.
      const departureMs = Math.max(cursorMs, Date.parse(best.departureTime));
      const arrivalMs = Date.parse(best.arrivalTime);
      steps.push({ legs: best.legs, departureMs, arrivalMs, atRisk: best.transferAtRisk });
      cursorMs = arrivalMs;
    }

    fromPlace = point.place;
    fromFix = null;
  }

  return {
    itinerary: stitch(steps),
    destinationLabel: placeLabel(points[points.length - 1]!.place),
    startIndex: start.index,
  };
}
