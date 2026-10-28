import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REFINE_MOVED_METERS,
  resolveCurrentPosition,
  type Coords,
  type LocationSource,
  type PositionUpdate,
} from './resolve-current-position';

const HOME: Coords = { lat: 32.0853, lon: 34.7818 };

/** Moves `meters` due north of `from` -- latitude degrees are ~111.32 km
 *  apart everywhere, so this needs no longitude correction. */
function metersNorthOf(from: Coords, meters: number): Coords {
  return { lat: from.lat + meters / 111_320, lon: from.lon };
}

const NEVER = new Promise<never>(() => {});

function source(overrides: Partial<LocationSource>): LocationSource {
  return {
    requestPermission: async () => true,
    hasPermission: async () => true,
    lastKnown: async () => null,
    current: () => NEVER,
    ...overrides,
  };
}

async function run(
  src: LocationSource,
  previous: Coords | null = null,
  interactive = true,
): Promise<PositionUpdate[]> {
  const updates: PositionUpdate[] = [];
  await resolveCurrentPosition(src, {
    timeoutMs: 20,
    previous,
    interactive,
    onUpdate: (update) => updates.push(update),
  });
  return updates;
}

test('a denied permission is reported without asking for a position', async () => {
  let asked = false;
  const updates = await run(source({
    requestPermission: async () => false,
    lastKnown: async () => { asked = true; return HOME; },
    current: async () => { asked = true; return HOME; },
  }));

  assert.deepEqual(updates, [{ status: 'error', message: 'location_permission_denied' }]);
  assert.equal(asked, false);
});

test('the last known position is reported before the fresh fix settles', async () => {
  const updates: PositionUpdate[] = [];
  let resolveFresh!: (coords: Coords) => void;
  const pending = resolveCurrentPosition(
    source({
      lastKnown: async () => HOME,
      current: () => new Promise((resolve) => { resolveFresh = resolve; }),
    }),
    { timeoutMs: 1_000, previous: null, interactive: true, onUpdate: (update) => updates.push(update) },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [{ status: 'success', coords: HOME }]);

  resolveFresh(HOME);
  await pending;
});

test('a fresh fix that moved away from the last known position replaces it', async () => {
  const moved = metersNorthOf(HOME, REFINE_MOVED_METERS + 100);

  const updates = await run(source({ lastKnown: async () => HOME, current: async () => moved }));

  assert.deepEqual(updates, [
    { status: 'success', coords: HOME },
    { status: 'success', coords: moved },
  ]);
});

test('a fresh fix within the refine distance is not reported again', async () => {
  const nudged = metersNorthOf(HOME, REFINE_MOVED_METERS - 20);

  const updates = await run(source({ lastKnown: async () => HOME, current: async () => nudged }));

  assert.deepEqual(updates, [{ status: 'success', coords: HOME }]);
});

test('with no last known position the fresh fix is reported', async () => {
  const updates = await run(source({ current: async () => HOME }));

  assert.deepEqual(updates, [{ status: 'success', coords: HOME }]);
});

test('with no position at all a timed-out fix is reported as unavailable', async () => {
  const updates = await run(source({}));

  assert.deepEqual(updates, [{ status: 'error', message: 'location_unavailable' }]);
});

test('a failing fix is reported as unavailable', async () => {
  const updates = await run(source({ current: async () => { throw new Error('no provider'); } }));

  assert.deepEqual(updates, [{ status: 'error', message: 'location_unavailable' }]);
});

test('a timed-out fix after a last known position keeps that position', async () => {
  const updates = await run(source({ lastKnown: async () => HOME }));

  assert.deepEqual(updates, [{ status: 'success', coords: HOME }]);
});

test('a refresh that fails keeps the previous fix instead of reporting an error', async () => {
  const updates = await run(source({}), HOME);

  assert.deepEqual(updates, []);
});

test('a refresh whose last known position matches the previous fix reports nothing new', async () => {
  const updates = await run(source({ lastKnown: async () => HOME, current: async () => HOME }), HOME);

  assert.deepEqual(updates, []);
});

test('a last known position that throws falls through to the fresh fix', async () => {
  const updates = await run(source({
    lastKnown: async () => { throw new Error('unsupported'); },
    current: async () => HOME,
  }));

  assert.deepEqual(updates, [{ status: 'success', coords: HOME }]);
});

test('an interactive request prompts for permission and lets the fix ask for settings', async () => {
  const calls: string[] = [];
  await run(source({
    requestPermission: async () => { calls.push('request'); return true; },
    hasPermission: async () => { calls.push('check'); return true; },
    current: async (interactive) => { calls.push(`current:${interactive}`); return HOME; },
  }));

  assert.deepEqual(calls, ['request', 'current:true']);
});

test('a non-interactive request never opens a permission prompt or a settings dialog', async () => {
  // On Android both put a system activity over the app, which sends it to the
  // background and back -- and a refresh fired on every return would loop.
  const calls: string[] = [];
  const updates = await run(source({
    requestPermission: async () => { calls.push('request'); return true; },
    hasPermission: async () => { calls.push('check'); return true; },
    current: async (interactive) => { calls.push(`current:${interactive}`); return HOME; },
  }), null, false);

  assert.deepEqual(calls, ['check', 'current:false']);
  assert.deepEqual(updates, [{ status: 'success', coords: HOME }]);
});

test('a non-interactive request with the permission revoked reports it without prompting', async () => {
  let prompted = false;
  const updates = await run(source({
    requestPermission: async () => { prompted = true; return true; },
    hasPermission: async () => false,
  }), HOME, false);

  assert.deepEqual(updates, [{ status: 'error', message: 'location_permission_denied' }]);
  assert.equal(prompted, false);
});
