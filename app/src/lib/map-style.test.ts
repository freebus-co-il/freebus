import assert from 'node:assert/strict';
import { test } from 'node:test';

import { androidMapStyle } from './map-style';

const COMBINATIONS = [
  ['light', false],
  ['light', true],
  ['dark', false],
  ['dark', true],
] as const;

test('every map gets a non-empty style, in either scheme, monochrome or not', () => {
  // Since an Android update on the S25, a Google map with no style -- or an
  // EMPTY one -- draws its routes over a blank basemap. Only a real style
  // brings the streets back.
  for (const [scheme, monochrome] of COMBINATIONS) {
    assert.ok(androidMapStyle(scheme, monochrome).length > 0, `${scheme}, monochrome=${monochrome}`);
  }
});

test('the light style draws nothing different from the default map', () => {
  assert.deepEqual(androidMapStyle('light', false), [{ stylers: [{ visibility: 'on' }] }]);
});

test('the dark style paints the map dark', () => {
  const dark = androidMapStyle('dark', false);

  assert.notDeepEqual(dark, androidMapStyle('light', false));
  assert.ok(
    dark.some((rule) => rule.elementType === 'geometry' && rule.featureType === undefined && rule.stylers.some((styler) => 'color' in styler)),
    'a colour for every feature geometry',
  );
});

test('monochrome drains the colour on top of the scheme instead of replacing it', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const base = androidMapStyle(scheme, false);
    const monochrome = androidMapStyle(scheme, true);

    assert.deepEqual(monochrome.slice(0, base.length), base);
    assert.deepEqual(monochrome.at(-1), { stylers: [{ saturation: -100 }] });
  }
});

test('the same appearance hands back the same array, so a map is not restyled on every render', () => {
  for (const [scheme, monochrome] of COMBINATIONS) {
    assert.equal(androidMapStyle(scheme, monochrome), androidMapStyle(scheme, monochrome));
  }
});
