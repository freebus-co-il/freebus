import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TFunction } from 'i18next';

import type { Itinerary } from '@/api/types';
import { buildStepCards, type LegCard } from '@/features/trip/step-cards';

import { at, sampleJourney } from './journey-fixtures';
import { canSwitchLine, journeyCardModel, type JourneyCardFormat } from './journey-card-model';
import { resolveJourneyState } from './journey-machine';
import { DEFAULT_ALERT_SETTINGS, type ActiveJourney } from './types';

const t = ((key: string) => key) as unknown as TFunction;

/**
 * A `t` that also keeps what it was asked to interpolate.
 *
 * The bare stub above returns the key and DROPS its values, which makes an
 * assertion about what a card does not say blind to the only shape the leak
 * could take: every string this module produces goes through `t`, so a card
 * that printed the boarding stop via `t('journey.card.boardAt', { name })`
 * would still stringify to nothing but the key and read as clean. The
 * `absent` assertions below look at `interpolated` as well as at the model.
 */
function recordingT() {
  const interpolated: unknown[] = [];
  const record = ((key: string, values?: Record<string, unknown>) => {
    interpolated.push(values ?? null);
    return key;
  }) as unknown as TFunction;
  return { t: record, interpolated };
}

const format: JourneyCardFormat = {
  clock: (iso: string) => new Date(iso).toISOString().slice(11, 16),
  distance: (meters: number) => `${meters} m`,
  duration: (seconds: number) => `${Math.round(seconds / 60)} min`,
};

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

  const { t: recorded, interpolated } = recordingT();
  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', recorded, format);
  assert.equal(model.headline, 'Allenby');
  assert.equal(model.supporting, 'journey.phase.riding');
  assert.equal(model.tone, 'normal');
  assert.equal(model.canSwitchLine, true);
  assert.ok(
    !JSON.stringify([model, interpolated]).includes('Rothschild'),
    'the boarding stop must not appear once riding -- neither in the model nor in anything handed to `t`',
  );
});

test('riding with no fix falls back to the clock rather than inventing a count', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:20:00.000Z'));
  assert.equal(state.phase, 'riding');
  assert.equal(state.stopsRemaining, null);

  const { t: recorded, interpolated } = recordingT();
  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', recorded, format);
  assert.equal(model.headline, 'Allenby');
  assert.equal(model.supporting, 'journey.phase.ridingUntil');
  assert.ok(!JSON.stringify([model, interpolated]).includes('Rothschild'));
});

test('waiting leads with the departure and says which way the bus is headed', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'));
  assert.equal(state.phase, 'waiting');

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t, format);
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

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t, format);
  assert.equal(model.headline, 'journey.phase.alightSoon');
  assert.equal(model.supporting, 'Allenby');
  assert.equal(model.tone, 'alert');
  assert.equal(model.canSwitchLine, false);
});

test('a walk to a stop names the stop and the departure it is racing', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));
  assert.equal(state.phase, 'walking-to-stop');

  const model = journeyCardModel(cardFor(0), state, journey.itinerary, 'Home', t, format);
  assert.equal(model.headline, 'Rothschild');
  assert.equal(model.supporting, 'journey.card.catch');
  assert.equal(model.route, null);
  assert.equal(model.canSwitchLine, false);
});

test('the last walk names the destination the rider typed', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));
  assert.equal(state.phase, 'arriving');

  const model = journeyCardModel(cardFor(2), state, journey.itinerary, 'Home', t, format);
  assert.equal(model.headline, 'Home');
  assert.equal(model.supporting, 'journey.phase.arriving');
});

test('a leg the rider is not on shows where to board and where to get off', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t, format);
  assert.equal(model.headline, 'journey.card.boardAt');
  assert.equal(model.supporting, 'journey.card.offAt');
  assert.equal(model.canSwitchLine, true);
});

test('arrived on a ride card says arrived, never leaves-in', () => {
  // The API omits a zero-second egress walk, so a journey can end ON a ride
  // rather than on a final walk -- drop the sample's trailing walk leg to
  // reproduce that shape. `resolveJourneyState`'s `arrived` branch always
  // sets `legIndex = legs.length - 1` with `leg: null`, so the last card
  // here (a ride, not a walk) is the one that must say "arrived" rather than
  // falling through to the waiting branch's `journey.nav.leavesIn`.
  const rideEndingItinerary: Itinerary = { ...sampleJourney().itinerary, legs: sampleJourney().itinerary.legs.slice(0, 2) };
  const journey: ActiveJourney = { ...sampleJourney(), itinerary: rideEndingItinerary };
  const state = resolveJourneyState(journey, null, at('2026-08-31T11:00:00.000Z'));
  assert.equal(state.phase, 'arrived');
  assert.equal(state.leg, null);

  const card = buildStepCards(rideEndingItinerary).find(
    (entry): entry is LegCard => entry.kind !== 'overview' && entry.legIndex === 1,
  );
  if (!card) throw new Error('no card for leg 1');

  const model = journeyCardModel(card, state, rideEndingItinerary, 'Home', t, format);
  assert.equal(model.headline, 'journey.phase.arrived');
  assert.notEqual(model.headline, 'journey.nav.leavesIn');
  assert.equal(model.supporting, 'Home');
  assert.equal(model.canSwitchLine, false);
});

test('a leg already behind the rider offers no line switch', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));

  const model = journeyCardModel(cardFor(1), state, journey.itinerary, 'Home', t, format);
  assert.equal(model.canSwitchLine, false);
});

test('switchability answers the same for the card and for an open sheet', () => {
  // The journey screen re-asks this of every render while the sheet is up, so
  // it is the whole guard against `chooseLine` rewriting a ride the rider has
  // already finished -- `chooseLine` itself takes any leg index it is given.
  const journey = sampleJourney();
  const riding = resolveJourneyState(
    journey,
    { lat: 32.07, lon: 34.78, accuracyMeters: 10, at: '2026-08-31T10:20:00.000Z' },
    at('2026-08-31T10:20:00.000Z'),
  );
  assert.equal(riding.phase, 'riding');
  assert.equal(canSwitchLine(riding, 1), true, 'the ride under the rider');
  assert.equal(canSwitchLine(riding, 0), false, 'a leg already behind them');

  const alighting = resolveJourneyState(
    journey,
    { lat: 32.075, lon: 34.785, accuracyMeters: 10, at: '2026-08-31T10:28:00.000Z' },
    at('2026-08-31T10:28:00.000Z'),
    DEFAULT_ALERT_SETTINGS,
  );
  assert.equal(alighting.phase, 'alight-soon');
  assert.equal(canSwitchLine(alighting, 1), false, 'the get-off window belongs to the alarm');

  const walking = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));
  assert.equal(walking.phase, 'walking-to-stop');
  assert.equal(canSwitchLine(walking, 1), true, 'a ride still ahead');

  const arrived = resolveJourneyState(journey, null, at('2026-08-31T11:00:00.000Z'));
  assert.equal(arrived.phase, 'arrived');
  assert.equal(canSwitchLine(arrived, 1), false, 'nothing is switchable once the journey is done');

  // The reason this is a function and not four literals: an open sheet asks it
  // about a leg the rider is no longer on, which no card would ever render.
  assert.equal(canSwitchLine({ ...riding, phase: 'off-plan' }, 1), false);
});
