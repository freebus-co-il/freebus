import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveShortLink } from './resolve-short-link';

/** Stands in for a redirect chain: `fetch` follows them itself, so all the
 *  caller ever sees is the URL it ended up at. */
function fetchLanding(finalUrl: string) {
  return async () => ({ url: finalUrl, ok: true });
}

test('a short link resolves to the position it expands to', async () => {
  const resolved = await resolveShortLink(
    'https://maps.app.goo.gl/aBcD1234',
    fetchLanding('https://www.google.com/maps/place/Levinsky+Market/@32.0853,34.7818,17z'),
  );

  assert.deepEqual(resolved, {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: 'Levinsky Market',
  });
});

test('a short link that expands to no position resolves to nothing', async () => {
  const resolved = await resolveShortLink(
    'https://maps.app.goo.gl/aBcD1234',
    fetchLanding('https://consent.google.com/m?continue=whatever'),
  );

  assert.equal(resolved, null);
});

// The rider is standing on a platform with one bar of signal. A share that
// hangs forever is worse than one that admits it could not be read.
test('a short link that never answers resolves to nothing', async () => {
  const resolved = await resolveShortLink(
    'https://maps.app.goo.gl/aBcD1234',
    () => new Promise(() => {}),
    { timeoutMs: 10 },
  );

  assert.equal(resolved, null);
});

test('a network failure resolves to nothing rather than throwing', async () => {
  const resolved = await resolveShortLink('https://maps.app.goo.gl/aBcD1234', async () => {
    throw new Error('offline');
  });

  assert.equal(resolved, null);
});

// Following a link means fetching a URL a stranger put in a message. Only the
// shorteners the parser recognises are ever requested.
test('a link that is not a known map shortener is never fetched', async () => {
  let requested = false;
  const resolved = await resolveShortLink('https://evil.example.com/track/me', async () => {
    requested = true;
    return { url: 'https://evil.example.com/track/me', ok: true };
  });

  assert.equal(resolved, null);
  assert.equal(requested, false);
});
