import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JourneySurfaceCopy } from './live-surface';
import { sameFacts, surfaceFacts } from './surface-facts';
import type { JourneyState } from './types';

const copy: JourneySurfaceCopy = { hero: '480', supporting: 'towards Bat Yam', accent: '#000', alightNow: 'NOW', liveLabel: 'Live' };
function state(to: string | null, overrides: Partial<JourneyState> = {}): JourneyState {
  return {
    phase: 'waiting', legIndex: 1, leg: null, stopsRemaining: null,
    timer: to ? { from: '2026-08-31T10:00:00.000Z', to, countsDown: true } : null,
    offPlan: null, progress: 0.2, timeSource: 'live', busStopsAway: 3, stopsSource: null,
    nextStopName: null, arrivalTime: '2026-08-31T10:35:00.000Z', trackedLegIndex: null,
    ridingEarly: false, ...overrides,
  };
}
const facts = (s: JourneyState, c: JourneySurfaceCopy = copy) => surfaceFacts(s, c);

test('nothing changed is nothing to push', () => {
  assert.equal(sameFacts(facts(state('2026-08-31T10:10:00.000Z')), facts(state('2026-08-31T10:10:00.000Z'))), true);
});

test('a deadline moving by less than a minute is not worth an update', () => {
  assert.equal(sameFacts(facts(state('2026-08-31T10:10:00.000Z')), facts(state('2026-08-31T10:10:59.000Z'))), true);
});

test('a deadline moving by a minute or more is', () => {
  assert.equal(sameFacts(facts(state('2026-08-31T10:10:00.000Z')), facts(state('2026-08-31T10:11:00.000Z'))), false);
});

test('gaining or losing a deadline is a change', () => {
  assert.equal(sameFacts(facts(state('2026-08-31T10:10:00.000Z')), facts(state(null))), false);
});

test('the live label and the clock it names are facts', () => {
  const base = facts(state('2026-08-31T10:10:00.000Z'));
  assert.equal(sameFacts(base, facts(state('2026-08-31T10:10:00.000Z'), { ...copy, liveLabel: 'Scheduled' })), false);
  assert.equal(sameFacts(base, facts(state('2026-08-31T10:10:00.000Z', { timeSource: 'scheduled' }))), false);
});

test('the bus count and who counted the stops are not: no surface prints them', () => {
  // A bus approaching from twelve stops would otherwise cost twelve updates,
  // and the count source flips on accuracy and age thresholds.
  const base = facts(state('2026-08-31T10:10:00.000Z'));
  assert.equal(sameFacts(base, facts(state('2026-08-31T10:10:00.000Z', { busStopsAway: 2 }))), true);
  assert.equal(sameFacts(base, facts(state('2026-08-31T10:10:00.000Z', { stopsSource: 'bus' }))), true);
});

test('nothing pushed yet always pushes', () => {
  assert.equal(sameFacts(null, facts(state(null))), false);
});
