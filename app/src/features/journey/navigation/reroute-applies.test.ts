import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rerouteApplies } from './reroute-applies';

const to = { lat: 32.08, lon: 34.78 };
const reroute = { legIndex: 0, to, geometry: 'g', steps: [] };

test('a re-route still applies to the same walk', () => {
  assert.equal(rerouteApplies(reroute, 0, { to }), true);
});

test('a re-route is dropped when the walk now leads to a different stop', () => {
  assert.equal(rerouteApplies(reroute, 0, { to: { lat: 32.09, lon: 34.78 } }), false);
});

test('a re-route is dropped when the leg changes', () => {
  assert.equal(rerouteApplies(reroute, 1, { to }), false);
});
