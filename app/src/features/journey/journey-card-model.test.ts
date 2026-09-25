import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TFunction } from 'i18next';

import { at, sampleJourney } from './journey-fixtures';
import { journeyCardModel } from './journey-card-model';
import { resolveJourneyState } from './journey-machine';
import { buildStepCards, type LegCard } from '@/features/trip/step-cards';
import { DEFAULT_ALERT_SETTINGS } from './types';

const t = ((key: string) => key) as unknown as TFunction;

/** The leg cards of the sample journey: walk(0), ride(1), walk(2). */
function cardFor(legIndex: number): LegCard {
  const card = buildStepCards(sampleJourney().itinerary).find(
    (entry): entry is LegCard => entry.kind !== 'overview' && entry.legIndex === legIndex,
  );
  // A thrown error rather than `assert.ok`: TypeScript's assertion narrowing
  // needs an explicit type annotation on the imported assert, which this
  // project's tests do not carry.
  if (!card) throw new Error(`no card for leg ${legIndex}`);
  return card;
}

test('riding with a fix counts stops and never names the stop boarded at', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(
    journey,
    { lat: 32.07, lon: 34.78, accuracyMeters: 10, at: '2026-08-31T10:20:00.000Z' },
    at('2026-08-31T10:20:00.000Z'),
  );
  assert.equal(state.phase, 'riding');
  assert.notEqual(state.stopsRemaining, null);

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'Allenby');
  assert.equal(model.supporting, 'journey.phase.riding');
  assert.equal(model.tone, 'normal');
  assert.equal(model.canSwitchLine, true);
  assert.ok(!JSON.stringify(model).includes('Rothschild'), 'the boarding stop must not appear once riding');
});

test('riding with no fix falls back to the clock rather than inventing a count', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:20:00.000Z'));
  assert.equal(state.phase, 'riding');
  assert.equal(state.stopsRemaining, null);

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'Allenby');
  assert.equal(model.supporting, 'journey.phase.ridingUntil');
  assert.ok(!JSON.stringify(model).includes('Rothschild'));
});

test('waiting leads with the departure and says which way the bus is headed', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'));
  assert.equal(state.phase, 'waiting');

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'journey.nav.leavesIn');
  assert.equal(model.supporting, 'results.towards');
  assert.equal(model.canSwitchLine, true);
});

test('the get-off moment is an alert and offers no line switch', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(
    journey,
    { lat: 32.075, lon: 34.785, accuracyMeters: 10, at: '2026-08-31T10:28:00.000Z' },
    at('2026-08-31T10:28:00.000Z'),
    DEFAULT_ALERT_SETTINGS,
  );
  assert.equal(state.phase, 'alight-soon');

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'journey.phase.alightSoon');
  assert.equal(model.supporting, 'Allenby');
  assert.equal(model.tone, 'alert');
  assert.equal(model.canSwitchLine, false);
});

test('a walk to a stop names the stop and the departure it is racing', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));
  assert.equal(state.phase, 'walking-to-stop');

  const model = journeyCardModel(cardFor(0), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'Rothschild');
  assert.equal(model.supporting, 'journey.card.catch');
  assert.equal(model.route, null);
  assert.equal(model.canSwitchLine, false);
});

test('the last walk names the destination the rider typed', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));
  assert.equal(state.phase, 'arriving');

  const model = journeyCardModel(cardFor(2), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'Home');
  assert.equal(model.supporting, 'journey.phase.arriving');
});

test('a leg the rider is not on shows where to board and where to get off', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t);
  assert.equal(model.headline, 'journey.card.boardAt');
  assert.equal(model.supporting, 'journey.card.offAt');
  assert.equal(model.canSwitchLine, true);
});

test('a leg already behind the rider offers no line switch', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t);
  assert.equal(model.canSwitchLine, false);
});
