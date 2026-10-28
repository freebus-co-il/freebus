import assert from 'node:assert/strict';
import { test } from 'node:test';

import i18next from 'i18next';

import en from './locales/en.json';
import he from './locales/he.json';

/**
 * A vehicle's age label sits on the map next to countdowns, so it has to read
 * as the past ("1 min ago"), never as an ETA ("1 min").
 */
async function translator(lng: 'he' | 'en') {
  const instance = i18next.createInstance();
  await instance.init({ lng, resources: { he: { translation: he }, en: { translation: en } } });
  return instance.t.bind(instance);
}

test('Hebrew vehicle age reads as the past', async () => {
  const t = await translator('he');
  assert.equal(t('results.vehicleAge', { count: 1 }), 'לפני דקה');
  assert.equal(t('results.vehicleAge', { count: 2 }), 'לפני 2 דק׳');
  assert.equal(t('results.vehicleAge', { count: 7 }), 'לפני 7 דק׳');
});

test('English vehicle age reads as the past', async () => {
  const t = await translator('en');
  assert.equal(t('results.vehicleAge', { count: 1 }), '1 min ago');
  assert.equal(t('results.vehicleAge', { count: 4 }), '4 min ago');
});
