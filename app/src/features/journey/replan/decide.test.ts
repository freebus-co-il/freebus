import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary } from '@/api/types';

import { backboneOf } from './backbone';
import { decideSwitch } from './decide';
import { itin, ms, ride, stop, t } from './fixtures';

const HOME = stop('home', 0);
const SAVIDOR = stop('savidor', 2000);
const RAANANA = stop('raanana', 20000);

/** Bus to Savidor, train to Ra'anana, arriving at `arr`. */
const viaTrain = (busDep: number, arr: number, line = '125'): Itinerary => itin([
  ride({ line, from: HOME, to: SAVIDOR, dep: busDep, arr: busDep + 20 }),
  ride({ routeType: 2, line: 'IR', from: SAVIDOR, to: RAANANA, dep: arr - 15, arr }),
]);
const busOnly = (dep: number, arr: number): Itinerary => itin([ride({ line: '605', from: HOME, to: RAANANA, dep, arr })]);

const current = viaTrain(10, 60);
const { backbone } = backboneOf(current)!;
const nowMs = ms(0);
const readyAtMs = () => nowMs;
const base = { currentArrival: t(60), broken: false, backbone, nowMs, lastSwitchAt: null, readyAtMs };

test('keeps when nothing is 2 minutes better', () => {
  assert.deepEqual(decideSwitch({ ...base, candidates: [viaTrain(8, 59)] }), { kind: 'keep' });
});

test('switches to a candidate 3 minutes earlier inside the boundary', () => {
  const better = viaTrain(5, 57, '189');
  const decision = decideSwitch({ ...base, candidates: [viaTrain(8, 59), better] });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.kind === 'switch' && decision.itinerary, better);
  assert.equal(decision.kind === 'switch' && decision.gainSeconds, 180);
});

test('never auto-switches outside the boundary even when much faster', () => {
  assert.deepEqual(decideSwitch({ ...base, candidates: [busOnly(5, 40)] }), { kind: 'keep' });
});

test('offers the outside option only when the plan is broken', () => {
  const bus = busOnly(5, 40);
  const decision = decideSwitch({ ...base, broken: true, candidates: [bus] });
  assert.deepEqual(decision, { kind: 'offer', itinerary: bus });
});

test('a broken plan switches to any inside candidate, even a later one', () => {
  const later = viaTrain(30, 90);
  const decision = decideSwitch({ ...base, broken: true, candidates: [later, busOnly(5, 40)] });
  assert.equal(decision.kind === 'switch' && decision.itinerary, later);
});

test('stuck when broken and no candidates', () => {
  assert.deepEqual(decideSwitch({ ...base, broken: true, candidates: [] }), { kind: 'stuck' });
});

test('keep with candidates: [] when not broken', () => {
  assert.deepEqual(decideSwitch({ ...base, candidates: [] }), { kind: 'keep' });
});

test('drops a candidate whose bus leaves before the rider can reach it', () => {
  const tooSoon = viaTrain(2, 50, '189');
  const decision = decideSwitch({ ...base, candidates: [tooSoon], readyAtMs: () => ms(4) });
  assert.deepEqual(decision, { kind: 'keep' });
});

test('hysteresis: keeps within 90 s of the last switch unless broken', () => {
  const better = viaTrain(5, 50, '189');
  assert.deepEqual(decideSwitch({ ...base, lastSwitchAt: nowMs - 60_000, candidates: [better] }), { kind: 'keep' });
  assert.equal(decideSwitch({ ...base, broken: true, lastSwitchAt: nowMs - 60_000, candidates: [better] }).kind, 'switch');
  assert.equal(decideSwitch({ ...base, lastSwitchAt: nowMs - 100_000, candidates: [better] }).kind, 'switch');
});

test('with no backbone every candidate is inside the boundary', () => {
  assert.equal(decideSwitch({ ...base, backbone: null, candidates: [busOnly(5, 40)] }).kind, 'switch');
});

const risky = (it: Itinerary): Itinerary => ({ ...it, transferAtRisk: true });

test('prefers a safe candidate over a sooner one whose transfer is at risk', () => {
  const safe = viaTrain(8, 57, '189');
  const decision = decideSwitch({ ...base, candidates: [risky(viaTrain(5, 52, '25')), safe] });
  assert.equal(decision.kind === 'switch' && decision.itinerary, safe);
});

test('never switches onto a risky way when nothing is broken', () => {
  assert.deepEqual(decideSwitch({ ...base, candidates: [risky(viaTrain(5, 50, '25'))] }), { kind: 'keep' });
});

test('broken: offers a safe outside way before switching to a risky inside one', () => {
  const bus = busOnly(5, 70);
  const decision = decideSwitch({ ...base, broken: true, candidates: [risky(viaTrain(5, 55, '25')), bus] });
  assert.deepEqual(decision, { kind: 'offer', itinerary: bus });
});

test('broken: falls back to a risky inside way when nothing is safe', () => {
  const inside = risky(viaTrain(5, 55, '25'));
  const decision = decideSwitch({ ...base, broken: true, candidates: [inside, risky(busOnly(5, 40))] });
  assert.equal(decision.kind === 'switch' && decision.itinerary, inside);
});
