import type { ActiveJourney, RiderPosition } from './types';
import type { Itinerary, TransitLeg, WalkLeg } from '@/api/types';

/** walk 5m -> bus (wait 5m, ride 20m) -> walk 5m, starting 10:00. */
export function sampleItinerary(): Itinerary {
  return {
    departureTime: '2026-08-31T10:00:00.000Z',
    arrivalTime: '2026-08-31T10:35:00.000Z',
    durationSeconds: 2100,
    transfers: 0,
    walkSeconds: 600,
    walkMeters: 700,
    transferAtRisk: null,
    legs: [
      {
        type: 'walk',
        from: { type: 'coordinate', lat: 32.06, lon: 34.77 },
        to: { type: 'stop', lat: 32.061, lon: 34.771, name: 'Rothschild' },
        distanceMeters: 350,
        durationSeconds: 300,
        geometry: null,
        walkEstimated: false,
      },
      {
        type: 'transit',
        route: { id: 'r1', agencyId: '3', shortName: '480', longName: '', type: 3, color: null },
        tripId: 't1',
        headsign: 'Bat Yam',
        directionId: 0,
        from: {
          stop: { type: 'stop', lat: 32.061, lon: 34.771, stopId: 's1', name: 'Rothschild' },
          departureTime: '2026-08-31T10:10:00.000Z',
          stopSequence: 1,
        },
        to: {
          stop: { type: 'stop', lat: 32.08, lon: 34.79, stopId: 's4', name: 'Allenby' },
          arrivalTime: '2026-08-31T10:30:00.000Z',
          stopSequence: 4,
        },
        numStops: 3,
        intermediateStops: [
          { type: 'stop', lat: 32.07, lon: 34.78, stopId: 's2', name: 'Mid A' },
          { type: 'stop', lat: 32.075, lon: 34.785, stopId: 's3', name: 'Mid B' },
        ],
        geometry: null,
        geometryFallback: false,
        realtime: null,
      },
      {
        type: 'walk',
        from: { type: 'stop', lat: 32.08, lon: 34.79, name: 'Allenby' },
        to: { type: 'coordinate', lat: 32.081, lon: 34.791 },
        distanceMeters: 350,
        durationSeconds: 300,
        geometry: null,
        walkEstimated: false,
      },
    ],
  };
}

export function sampleJourney(): ActiveJourney {
  return {
    id: 'j1',
    itinerary: sampleItinerary(),
    signature: 'sig',
    departure: '2026-08-31T10:00:00.000Z',
    startedAt: '2026-08-31T09:58:00.000Z',
    destinationLabel: 'Home',
    acknowledgedAlightLegIndex: null,
  };
}

export const at = (iso: string) => new Date(iso);

/** A rider fix. `iso` is when it was taken, which is what makes it fresh or stale. */
export function fix(lat: number, lon: number, iso: string, accuracyMeters = 10): RiderPosition {
  return { lat, lon, accuracyMeters, at: iso };
}

/** 480 Rothschild -> Allenby (10:10-10:30), walk to Dizengoff (10:30-10:35),
 *  142 Dizengoff -> Ramat Aviv (10:40-10:55). */
export function twoRideItinerary(): Itinerary {
  const base = sampleItinerary();
  const first = base.legs[1] as TransitLeg;
  return {
    ...base,
    arrivalTime: '2026-08-31T10:55:00.000Z',
    durationSeconds: 3300,
    transfers: 1,
    legs: [
      base.legs[0] as WalkLeg,
      first,
      {
        type: 'walk',
        from: { type: 'stop', lat: 32.08, lon: 34.79, name: 'Allenby' },
        to: { type: 'stop', lat: 32.082, lon: 34.792, name: 'Dizengoff' },
        distanceMeters: 300,
        durationSeconds: 300,
        geometry: null,
        walkEstimated: false,
      },
      {
        ...first,
        route: { ...first.route, id: 'r2', shortName: '142' },
        tripId: 't2',
        headsign: 'Ramat Aviv',
        from: {
          stop: { type: 'stop', lat: 32.082, lon: 34.792, stopId: 's5', name: 'Dizengoff' },
          departureTime: '2026-08-31T10:40:00.000Z',
          stopSequence: 1,
        },
        to: {
          stop: { type: 'stop', lat: 32.1, lon: 34.8, stopId: 's6', name: 'Ramat Aviv' },
          arrivalTime: '2026-08-31T10:55:00.000Z',
          stopSequence: 2,
        },
        numStops: 1,
        intermediateStops: [],
      },
    ],
  };
}

export function twoRideJourney(): ActiveJourney {
  return { ...sampleJourney(), itinerary: twoRideItinerary() };
}
