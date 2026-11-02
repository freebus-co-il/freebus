import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInstance } from 'i18next';

import ar from './locales/ar.json';
import en from './locales/en.json';
import es from './locales/es.json';
import he from './locales/he.json';
import ru from './locales/ru.json';

/**
 * With the rider's stop the very next one, the ride's count is zero, and
 * "0 more stops" reads as if the ride were over. Reported from the field as
 * "עוד 0 תחנות" on the train, one station out.
 */
async function translator(lng: 'he' | 'en' | 'ar' | 'ru' | 'es') {
  const instance = createInstance();
  await instance.init({ lng, resources: { he: { translation: he }, en: { translation: en }, ar: { translation: ar }, ru: { translation: ru }, es: { translation: es } } });
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

test('Arabic says the next stop instead of zero stops', async () => {
  const t = await translator('ar');
  assert.equal(t('journey.sheet.stopsLeft', { count: 0 }), 'المحطة القادمة');
  assert.equal(t('journey.phase.riding', { count: 0 }), 'المحطة القادمة');
  assert.equal(t('journey.sheet.stopsLeft', { count: 1 }), 'بقيت محطة واحدة');
  assert.equal(t('journey.sheet.stopsLeft', { count: 2 }), 'بقيت محطتان');
  assert.equal(t('journey.sheet.stopsLeft', { count: 3 }), 'بقيت 3 محطات');
  assert.equal(t('journey.sheet.stopsLeft', { count: 11 }), 'بقيت 11 محطة');
});

test('Russian says the next stop and agrees the count', async () => {
  const t = await translator('ru');
  assert.equal(t('journey.sheet.stopsLeft', { count: 0 }), 'Следующая остановка');
  assert.equal(t('journey.sheet.stopsLeft', { count: 1 }), 'Ещё 1 остановка');
  assert.equal(t('journey.sheet.stopsLeft', { count: 3 }), 'Ещё 3 остановки');
  assert.equal(t('journey.sheet.stopsLeft', { count: 5 }), 'Ещё 5 остановок');
  assert.equal(t('journey.sheet.stopsLeft', { count: 21 }), 'Ещё 21 остановка');
});

test('Spanish says the next stop instead of zero stops', async () => {
  const t = await translator('es');
  assert.equal(t('journey.sheet.stopsLeft', { count: 0 }), 'Próxima parada');
  assert.equal(t('journey.sheet.stopsLeft', { count: 1 }), 'Falta 1 parada');
  assert.equal(t('journey.sheet.stopsLeft', { count: 4 }), 'Faltan 4 paradas');
});

test('Hebrew counts two in Hebrew, not English', async () => {
  const t = await translator('he');
  assert.equal(t('results.leaveIn', { count: 2 }), 'בעוד 2 דק׳');
  assert.equal(t('run.stopCount', { count: 2 }), 'שתי תחנות');
});
