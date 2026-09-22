import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSharedText } from './parse-shared-place';

test('a geo: URI is read as a coordinate', () => {
  assert.deepEqual(parseSharedText('geo:32.0853,34.7818'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: null,
  });
});

test("a Google Maps ?q= link is read as a coordinate", () => {
  assert.deepEqual(parseSharedText('https://www.google.com/maps?q=32.0853,34.7818'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: null,
  });
});

// What Google Maps' own "share" produces for a dropped pin: the coordinates
// live in the path after an `@`, followed by a zoom level that must not be
// mistaken for part of the pair.
test('a Google Maps @lat,lon,zoom path is read as a coordinate', () => {
  assert.deepEqual(parseSharedText('https://www.google.com/maps/@32.0853,34.7818,17z'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: null,
  });
});

test('an Apple Maps ?ll= link is read as a coordinate', () => {
  assert.deepEqual(parseSharedText('https://maps.apple.com/?ll=32.0853,34.7818&q=Dropped%20Pin'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: 'Dropped Pin',
  });
});

test('a Waze ?ll= link is read as a coordinate', () => {
  assert.deepEqual(parseSharedText('https://waze.com/ul?ll=32.0853%2C34.7818&navigate=yes'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: null,
  });
});

// WhatsApp and iOS Messages wrap the link in a sentence rather than sharing
// it alone, so the URL has to be found inside the text, not assumed to be it.
test('a link surrounded by chat text is still found', () => {
  assert.deepEqual(parseSharedText('see you here! https://www.google.com/maps?q=32.0853,34.7818 at 8'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: null,
  });
});

test('a bare coordinate pair is read as a coordinate', () => {
  assert.deepEqual(parseSharedText('32.0853, 34.7818'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: null,
  });
});

// A house number and a street number are also "two numbers with a comma".
// Coordinates out of range are the clearest signal that this is prose.
test('numbers outside coordinate range are not read as a coordinate', () => {
  assert.notEqual(parseSharedText('Herzl 100, 91 Tel Aviv')?.kind, 'coordinate');
});

// The link WhatsApp and Google Maps most often produce carries no position at
// all -- only resolving it can say where it points, so the parser must hand it
// back for that rather than guess.
test('a Google Maps short link is returned as a link to resolve', () => {
  assert.deepEqual(parseSharedText('https://maps.app.goo.gl/aBcD1234'), {
    kind: 'shortLink',
    url: 'https://maps.app.goo.gl/aBcD1234',
  });
});

test('the older goo.gl/maps short link is also returned as a link to resolve', () => {
  assert.deepEqual(parseSharedText('https://goo.gl/maps/aBcD1234'), {
    kind: 'shortLink',
    url: 'https://goo.gl/maps/aBcD1234',
  });
});

// Only links known to expand into a map are followed. An arbitrary shortener
// in a shared message is a request to fetch a URL a stranger chose, and the
// app has no reason to make it.
test('an unrelated shortened link is not treated as a map link', () => {
  assert.notEqual(parseSharedText('https://bit.ly/aBcD1234')?.kind, 'shortLink');
});

// `geo:0,0?q=...` is the standard placeholder form: the position is in the
// query, and the leading pair is a stand-in that must not win.
test('a geo: URI with a placeholder pair reads the position from its query', () => {
  assert.deepEqual(parseSharedText('geo:0,0?q=32.0853,34.7818(Levinsky%20Market)'), {
    kind: 'coordinate',
    lat: 32.0853,
    lon: 34.7818,
    label: 'Levinsky Market',
  });
});

// The place name is right there in the path -- using it means the results
// screen names where the rider is going instead of saying "shared location".
test('a Google Maps place link names the destination from its path', () => {
  assert.deepEqual(
    parseSharedText('https://www.google.com/maps/place/Levinsky+Market/@32.0853,34.7818,17z'),
    { kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: 'Levinsky Market' },
  );
});

test('shared text with no link and no coordinates becomes a search query', () => {
  assert.deepEqual(parseSharedText('Dizengoff 100, Tel Aviv'), {
    kind: 'query',
    text: 'Dizengoff 100, Tel Aviv',
  });
});

test('a link with no position and no name in it yields nothing', () => {
  assert.equal(parseSharedText('https://example.com/article/123'), null);
});

test('an empty share yields nothing', () => {
  assert.equal(parseSharedText('   '), null);
});

// What a short link expands into. `@lat,lon` there is the map's viewport
// centre, while `!3d`/`!4d` is the pin itself -- they differ by enough to put
// the rider on the wrong side of a street, so the pin wins.
test('an expanded Google Maps link prefers the pin over the viewport centre', () => {
  assert.deepEqual(
    parseSharedText(
      'https://www.google.com/maps/place/Levinsky+Market/@32.0600,34.7700,15z/data=!4m6!3m5!1s0x0:0x0!8m2!3d32.0853!4d34.7818',
    ),
    { kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: 'Levinsky Market' },
  );
});
