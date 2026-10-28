import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRTLLanguage, needsDirectionRestart, resolveLanguage } from './resolve-language';

test('an explicit language preference wins over the device locale', () => {
  assert.equal(resolveLanguage('en', 'he'), 'en');
  assert.equal(resolveLanguage('he', 'en'), 'he');
});

test('the device preference follows a device locale the app supports', () => {
  assert.equal(resolveLanguage('device', 'en'), 'en');
  assert.equal(resolveLanguage('device', 'he'), 'he');
});

// Hebrew is the default because this is an Israeli transit app -- a rider whose
// phone is in a language the app does not speak is far likelier to read Hebrew
// than to be served by falling back to English.
test('an unsupported device locale falls back to Hebrew', () => {
  assert.equal(resolveLanguage('device', 'fr'), 'he');
  assert.equal(resolveLanguage('device', undefined), 'he');
});

test('Hebrew is RTL and English is not', () => {
  assert.equal(isRTLLanguage('he'), true);
  assert.equal(isRTLLanguage('en'), false);
});

// This is what gates `Updates.reloadAsync()`. Getting it wrong in either
// direction is bad: too eager restarts the app for nothing, too lax leaves
// Hebrew in a left-to-right layout (or English in a mirrored one).
test('a language laid out the wrong way needs a restart', () => {
  assert.equal(needsDirectionRestart('he', false), true);
  assert.equal(needsDirectionRestart('en', true), true);
});

test('a language already laid out its own way needs no restart', () => {
  assert.equal(needsDirectionRestart('he', true), false);
  assert.equal(needsDirectionRestart('en', false), false);
});

// Picking "device default" while the device is already showing that language
// changes the stored preference but nothing the rider can see -- restarting
// there would be a jarring no-op.
test('selecting device default resolves before deciding on a restart', () => {
  assert.equal(needsDirectionRestart(resolveLanguage('device', 'he'), true), false);
  assert.equal(needsDirectionRestart(resolveLanguage('device', 'en'), true), true);
});
