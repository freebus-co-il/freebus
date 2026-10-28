import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TFunction } from 'i18next';

import type { TransitLeg } from '@/api/types';

import { at, fix, sampleJourney } from './journey-fixtures';
import type { JourneyCopy } from './journey-copy';
import { resolveJourneyState } from './journey-machine';
import { surfaceCopy } from './surface-copy';
import { DEFAULT_ALERT_SETTINGS, type ActiveJourney, type JourneyState } from './types';

/** Echoes the key and its options, so a test asserts which sentence was
 *  chosen and what was put in it without depending on a locale. */
const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction;
const format = { clock: (iso: string) => iso.slice(11, 16), rtl: false };
const inApp: JourneyCopy = { hero: 'hero', heroStatic: 'static', supporting: 'supporting', action: null, accent: '#000' };

function copyAt(journey: ActiveJourney, state: JourneyState) {
  return surfaceCopy(inApp, state, journey.itinerary, t, format);
}

test('waiting leads with the direction, not the line the badge already shows', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'));
  const copy = copyAt(journey, state);
  assert.equal(state.phase, 'waiting');
  assert.equal(copy.hero, 'results.towards {"name":"Bat Yam"}');
  assert.equal(copy.supporting, 'journey.surface.fromStop {"name":"Rothschild"}');
  assert.equal(copy.countdownLabel, 'journey.surface.departsIn');
  assert.equal(copy.ride, null);
});

test('waiting lists the next rides from the same stop that still make it', () => {
  const journey = sampleJourney();
  const leg = journey.itinerary.legs[1] as TransitLeg;
  const run = (shortName: string, departure: string, missesConnection = false) => ({
    ...leg,
    route: { ...leg.route, shortName },
    from: { ...leg.from, departureTime: departure },
    missesConnection,
  });
  leg.alternatives = [
    run('852', '2026-08-31T10:30:00.000Z'),
    run('480', '2026-08-31T10:22:00.000Z'),
    run('18', '2026-08-31T10:15:00.000Z', true),
    run('5', '2026-08-31T10:40:00.000Z'),
  ];
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'));
  assert.equal(copyAt(journey, state).then, 'journey.surface.then {"rides":"480 10:22 · 852 10:30"}');
});

test('riding with a fix names the stop to get off at, the next stop, and fills the strip by stops', () => {
  const journey: ActiveJourney = { ...sampleJourney(), gpsLegIndex: 1 };
  const now = '2026-08-31T10:15:00.000Z';
  const state = resolveJourneyState(journey, fix(32.07, 34.78, now), at(now), { ...DEFAULT_ALERT_SETTINGS, leadStops: 1 });
  assert.equal(state.phase, 'riding');
  assert.notEqual(state.stopsRemaining, null);
  const copy = copyAt(journey, state);
  assert.equal(copy.hero, 'journey.surface.getOffAt {"name":"Allenby"}');
  assert.equal(copy.countdownLabel, '');
  assert.equal(copy.ride?.stops, 3);
  assert.equal(copy.ride?.passed, 3 - (state.stopsRemaining ?? 0));
  if (state.nextStopName) {
    assert.equal(copy.supporting, `journey.surface.nextStop {"name":"${state.nextStopName}"}`);
  }
});

test('riding without a fix never counts stops: it counts down to the arrival, labelled scheduled', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(state.phase, 'riding');
  const copy = copyAt(journey, state);
  assert.equal(copy.ride?.passed, null);
  assert.equal(copy.ride?.from, '2026-08-31T10:10:00.000Z');
  assert.equal(copy.ride?.to, '2026-08-31T10:30:00.000Z');
  assert.equal(copy.countdownLabel, 'journey.surface.arrivesIn');
  assert.equal(copy.liveLabel, 'journey.live.scheduled');
  assert.equal(copy.supporting, 'journey.surface.arrivesAt {"time":"10:30"}');
});

test('the get-off moment keeps the strip and names the stop', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:29:00.000Z'));
  assert.equal(state.phase, 'alight-soon');
  const copy = copyAt(journey, state);
  assert.equal(copy.hero, 'static');
  assert.equal(copy.supporting, 'Allenby');
  assert.notEqual(copy.ride, null);
});

test('arriving counts down to the arrival, not to a departure', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));
  assert.equal(state.phase, 'arriving');
  assert.equal(copyAt(journey, state).countdownLabel, 'journey.surface.arrivesIn');
});
