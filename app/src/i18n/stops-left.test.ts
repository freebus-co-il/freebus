import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInstance } from 'i18next';

import en from './locales/en.json';
import he from './locales/he.json';

/**
 * With the rider's stop the very next one, the ride's count is zero, and
 * "0 more stops" reads as if the ride were over. Reported from the field as
 * "עוד 0 תחנות" on the train, one station out.
 */
async function translator(lng: 'he' | 'en') {
  const instance = createInstance();
  await instance.init({ lng, resources: { he: { translation: he }, en: { translation: en } } });
  return instance.t.bind(instance);
}

test('Hebrew says the next stop instead of zero stops', async () => {
  const t = await translator('he');
  assert.equal(t('journey.sheet.stopsLeft', { count: 0 }), 'התחנה הבאה');
  assert.equal(t('journey.phase.riding', { count: 0 }), 'התחנה הבאה');
  assert.equal(t('journey.sheet.stopsLeft', { count: 1 }), 'עוד תחנה אחת');
  assert.equal(t('journey.sheet.stopsLeft', { count: 3 }), 'עוד 3 תחנות');
});

test('English says the next stop instead of zero stops', async () => {
  const t = await translator('en');
  assert.equal(t('journey.sheet.stopsLeft', { count: 0 }), 'Next stop');
  assert.equal(t('journey.phase.riding', { count: 0 }), 'Next stop');
  assert.equal(t('journey.sheet.stopsLeft', { count: 2 }), '2 more stops');
});
