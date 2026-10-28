import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redirectSharePath } from './redirect-system-path';

// The share extension's payload never travels in the URL -- the link is only
// a signal that one is waiting in the native module, so the app opens on its
// home screen and `share-intent-gate` does the rest.
test('the share extension link opens the app, not a route named after it', () => {
  assert.equal(redirectSharePath('/dataUrl=freebusShareKey#freebusShareKey'), '/');
});

test('a tapped geo: link is handed to the share screen', () => {
  assert.equal(redirectSharePath('geo:32.0853,34.7818'), '/share?text=geo%3A32.0853%2C34.7818');
});

// Whether the leading slash survives depends on how the OS handed the link
// over, and a link that missed the rewrite would land on "unmatched route".
test('a geo: link keeps working when it arrives with a leading slash', () => {
  assert.equal(redirectSharePath('/geo:32.0853,34.7818'), '/share?text=geo%3A32.0853%2C34.7818');
});

test('an ordinary route is left exactly as it came', () => {
  assert.equal(redirectSharePath('/results'), '/results');
});
