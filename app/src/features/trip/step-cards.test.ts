import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary } from '@/api/types';
import { sampleItinerary } from '@/features/journey/journey-fixtures';

import { buildStepCards, cardFocusLegIndex, journeyCardIndex } from './step-cards';

test('leads with the whole journey, then one card per leg', () => {
  const cards = buildStepCards(sampleItinerary());
  assert.deepEqual(
    cards.map((card) => (card.kind === 'overview' ? 'overview' : `${card.kind}:${card.legIndex}`)),
    ['overview', 'walk:0', 'ride:1', 'walk:2'],
  );
});

// The fixture walks 5 min to a bus leaving 10 min after the door departure:
// the 5 min stand at the stop belongs to the ride, which has a map to show.
test('folds the wait into the ride it waits for', () => {
  const ride = buildStepCards(sampleItinerary()).find((card) => card.kind === 'ride');
  assert.equal(ride?.kind === 'ride' ? ride.waitSeconds : undefined, 300);
});

test('marks only the last walk as ending at the destination', () => {
  const walks = buildStepCards(sampleItinerary()).filter((card) => card.kind === 'walk');
  assert.deepEqual(walks.map((card) => card.kind === 'walk' && card.final), [false, true]);
});

test('reports no wait when the rider boards on arrival', () => {
  const itinerary: Itinerary = { ...sampleItinerary(), departureTime: '2026-08-31T10:05:00.000Z' };
  const ride = buildStepCards(itinerary).find((card) => card.kind === 'ride');
  assert.equal(ride?.kind === 'ride' ? ride.waitSeconds : undefined, null);
});

test('focuses nothing on the overview and the leg on a leg card', () => {
  const cards = buildStepCards(sampleItinerary());
  assert.equal(cardFocusLegIndex(cards[0]), null);
  assert.equal(cardFocusLegIndex(cards[2]), 1);
  assert.equal(cardFocusLegIndex(undefined), null);
});

test('a running journey shows the card of the leg it is on', () => {
  const cards = buildStepCards(sampleItinerary());
  assert.equal(journeyCardIndex(cards, { phase: 'waiting', legIndex: 1 }), 2);
  assert.equal(journeyCardIndex(cards, { phase: 'arriving', legIndex: 2 }), 3);
});

test('an off-plan journey stays on the first card, where the way out is', () => {
  const cards = buildStepCards(sampleItinerary());
  assert.equal(journeyCardIndex(cards, { phase: 'off-plan', legIndex: 1 }), 0);
});
