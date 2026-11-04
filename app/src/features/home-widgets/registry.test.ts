import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRegistry, resolveOptions } from './registry-store';

type Item = { id: string; options?: { parse: (raw: unknown) => { size: number } } };

const sized: Item = {
  id: 'sized',
  options: { parse: (raw) => (typeof (raw as { size?: unknown })?.size === 'number' ? (raw as { size: number }) : { size: 1 }) },
};
const plain: Item = { id: 'plain' };

test('registered items are listed in the order they were registered', () => {
  const registry = createRegistry<Item>('Widget');
  registry.register(sized);
  registry.register(plain);
  assert.deepEqual(registry.list().map((item) => item.id), ['sized', 'plain']);
  assert.equal(registry.get('plain'), plain);
  assert.equal(registry.get('missing'), null);
});

test('an id registered twice is a mistake, not a silent replacement', () => {
  const registry = createRegistry<Item>('Widget');
  registry.register(plain);
  assert.throws(() => registry.register(plain), /Widget "plain" is registered twice/);
});

test('options are read through the item, defaults when nothing usable is stored', () => {
  assert.deepEqual(resolveOptions(sized, { sized: { size: 3 } }), { size: 3 });
  assert.deepEqual(resolveOptions(sized, { sized: 'junk' }), { size: 1 });
  assert.deepEqual(resolveOptions(sized, {}), { size: 1 });
  assert.equal(resolveOptions(plain, { plain: 'anything' }), undefined);
});
