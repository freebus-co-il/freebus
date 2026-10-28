import assert from 'node:assert/strict';
import { test } from 'node:test';

import en from '@/i18n/locales/en.json';
import he from '@/i18n/locales/he.json';
import type { WalkManeuver } from '@/api/types';

import { walkInstruction } from './walk-instruction';

const MANEUVERS: WalkManeuver[] = [
  'depart', 'arrive', 'straight', 'slight-right', 'right', 'sharp-right', 'slight-left', 'left', 'sharp-left',
  'uturn', 'roundabout', 'stairs', 'elevator', 'escalator', 'enter-building', 'exit-building', 'ferry',
];

function lookup(locale: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);
}

test('a turn names the street it leads onto', () => {
  assert.deepEqual(walkInstruction({ maneuver: 'right', street: 'הדקלים' }, null), {
    key: 'journey.nav.rightOnto', values: { street: 'הדקלים' },
  });
  assert.deepEqual(walkInstruction({ maneuver: 'right', street: null }, null), { key: 'journey.nav.right', values: {} });
});

test('stairs do not name the walkway they lead onto', () => {
  assert.deepEqual(walkInstruction({ maneuver: 'stairs', street: 'walkway' }, null), { key: 'journey.nav.stairs', values: {} });
});

test('arriving names the stop when there is one', () => {
  assert.deepEqual(walkInstruction({ maneuver: 'arrive', street: null }, 'Allenby'), {
    key: 'journey.nav.arriveAt', values: { name: 'Allenby' },
  });
  assert.deepEqual(walkInstruction({ maneuver: 'arrive', street: null }, null), { key: 'journey.nav.arrive', values: {} });
});

test('every move has a phrase in both languages, with and without a street', () => {
  for (const locale of [en, he]) {
    for (const maneuver of MANEUVERS) {
      for (const street of [null, 'X']) {
        const { key } = walkInstruction({ maneuver, street }, maneuver === 'arrive' && street ? 'Stop' : null);
        assert.equal(typeof lookup(locale, key), 'string', `${key} missing`);
      }
    }
  }
});

test('in Hebrew a number or a foreign name follows the prefix after a hyphen', () => {
  assert.deepEqual(walkInstruction({ maneuver: 'slight-right', street: '652' }, null, 'he').values, { street: '-652' });
  assert.deepEqual(walkInstruction({ maneuver: 'left', street: 'HaYarkon' }, null, 'he').values, { street: '-HaYarkon' });
  assert.deepEqual(walkInstruction({ maneuver: 'left', street: 'פיק"א' }, null, 'he').values, { street: 'פיק"א' });
  assert.deepEqual(walkInstruction({ maneuver: 'arrive', street: null }, '2000 Terminal', 'he').values, { name: '-2000 Terminal' });
  assert.deepEqual(walkInstruction({ maneuver: 'left', street: '652' }, null, 'en').values, { street: '652' });
});
