import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TFunction } from 'i18next';

import type { JourneyCopy } from './journey-copy';
import { at, fix, sampleJourney, twoRideJourney } from './journey-fixtures';
import { resolveJourneyState } from './journey-machine';
import { arrivedPipModel, pipModel } from './pip-model';
import { DEFAULT_ALERT_SETTINGS, type JourneyState, type LiveJourneyInput } from './types';

const t = ((key: string, options?: object) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction;
const copy: JourneyCopy = { hero: 'HERO', heroStatic: 'HERO', supporting: null, action: null, accent: '#000000' };
const clock = (iso: string) => iso.slice(11, 16);
const journey = sampleJourney();
const model = (state: JourneyState, realtimeAvailable = true) =>
  pipModel({ state, itinerary: journey.itinerary, copy, t, realtimeAvailable, clock });

const waitingLive: LiveJourneyInput = {
  legs: [{ legIndex: 1, predictedDeparture: '2026-08-31T10:12:00.000Z', predictedArrival: null, fetchedAt: '2026-08-31T10:06:50.000Z' }],
  connections: [],
  bus: { legIndex: 1, progress: { kind: 'toBoarding', stops: 3 }, recordedAt: '2026-08-31T10:06:50.000Z', lat: 32.05, lon: 34.76 },
};

test('walking to the first stop names the stop, counts down, and previews the line', () => {
  const m = model(resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z')));
  assert.equal(m.badge, null);
  assert.match(m.title, /journey\.pip\.walkTo .*"name":"Rothschild"/);
  assert.match(m.hero, /journey\.pip\.leavesIn .*"minutes":8/);
  assert.match(m.footer ?? '', /480/);
  assert.match(m.footer ?? '', /journey\.pip\.arrive/);
});

test('transferring leads with the walk to the next line, not just its name', () => {
  const connecting = twoRideJourney();
  const state = resolveJourneyState(connecting, null, at('2026-08-31T10:32:00.000Z'));
  const m = pipModel({ state, itinerary: connecting.itinerary, copy, t, realtimeAvailable: true, clock });
  assert.equal(m.tone, 'neutral');
  assert.equal(m.badge, null);
  assert.match(m.title, /journey\.pip\.walkTo .*142/);
  assert.match(m.hero, /journey\.pip\.leavesIn .*"minutes":8/);
  assert.match(m.footer ?? '', /journey\.pip\.arrive/);
});

test('arriving names the destination and counts down the walk', () => {
  const m = model(resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z')));
  assert.equal(m.title, 'journey.pip.walkToDestination');
  assert.match(m.hero, /journey\.pip\.minutes .*"minutes":3/);
});

test('waiting leads with the line, counts down, and says it is live', () => {
  const m = model(resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'), DEFAULT_ALERT_SETTINGS, waitingLive));
  assert.equal(m.tone, 'neutral');
  assert.equal(m.badge?.shortName, '480');
  assert.match(m.title, /results\.towards/);
  assert.match(m.hero, /journey\.pip\.arrivesIn .*"minutes":5/);
  assert.equal(m.liveLabel, 'journey.live.live');
  assert.match(m.footer ?? '', /journey\.bus\.toBoarding .*"count":3/);
});

test('no realtime deployment, no live label', () => {
  const m = model(resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z')), false);
  assert.equal(m.liveLabel, '');
});

test('riding with a count names the next stop instead of the line', () => {
  const m = model(resolveJourneyState(journey, fix(32.069, 34.779, '2026-08-31T10:14:58.000Z'), at('2026-08-31T10:15:00.000Z')));
  assert.match(m.title, /journey\.pip\.next .*Mid A/);
  assert.equal(m.badge, null);
  assert.match(m.hero, /journey\.phase\.riding/);
  assert.match(m.footer ?? '', /journey\.pip\.getOffAt .*Allenby/);
});

test('riding without a count falls back to the time', () => {
  const m = model(resolveJourneyState(journey, null, at('2026-08-31T10:15:00.000Z')));
  assert.equal(m.badge?.shortName, '480');
  assert.match(m.hero, /journey\.phase\.ridingUntil/);
});

test('the get-off moment turns the window orange and names the stop', () => {
  const m = model(resolveJourneyState(journey, null, at('2026-08-31T10:29:00.000Z')));
  assert.equal(m.tone, 'getOff');
  assert.equal(m.title, 'journey.alert.getOffNow');
  assert.equal(m.hero, 'Allenby');
});

test('off plan is red and points back into the app', () => {
  const m = model(resolveJourneyState(journey, fix(32.061, 34.771, '2026-08-31T10:13:00.000Z'), at('2026-08-31T10:13:00.000Z')));
  assert.equal(m.tone, 'offPlan');
  assert.equal(m.title, 'HERO');
  assert.equal(m.hero, 'journey.pip.openToReplan');
});

test('arrived has a title and nothing else', () => {
  assert.deepEqual(arrivedPipModel(t), { tone: 'neutral', badge: null, title: 'journey.phase.arrived', hero: '', footer: null, liveLabel: '' });
});
