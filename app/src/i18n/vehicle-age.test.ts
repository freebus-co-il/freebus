import assert from 'node:assert/strict';
import { test } from 'node:test';

import i18next from 'i18next';

import ar from './locales/ar.json';
import en from './locales/en.json';
import he from './locales/he.json';

/**
 * A vehicle's age label sits on the map next to countdowns, so it has to read
 * as the past ("1 min ago"), never as an ETA ("1 min").
 */
async function translator(lng: 'he' | 'en' | 'ar') {
  const instance = i18next.createInstance();
  await instance.init({ lng, resources: { he: { translation: he }, en: { translation: en }, ar: { translation: ar } } });
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

test('Arabic vehicle age reads as the past', async () => {
  const t = await translator('ar');
  assert.equal(t('results.vehicleAge', { count: 1 }), 'قبل دقيقة');
  assert.equal(t('results.vehicleAge', { count: 2 }), 'قبل دقيقتين');
  assert.equal(t('results.vehicleAge', { count: 5 }), 'قبل 5 دقائق');
  assert.equal(t('results.vehicleAge', { count: 15 }), 'قبل 15 دقيقة');
});
