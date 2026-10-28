import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agenciesForTypes,
  effectiveTypes,
  excludeType,
  lockedType,
  typesForAgencies,
  type AgencyTypes,
} from './filter-interlock';

/** A feed shaped like the real one: most operators run one kind of vehicle,
 *  a few run two, and rail is a single operator of its own. */
const FEED: AgencyTypes[] = [
  { agencyId: 'dan', types: [3] },
  { agencyId: 'egged', types: [3, 8] },
  { agencyId: 'cfir', types: [0, 3] },
  { agencyId: 'rail', types: [2] },
];

test('no operator picked leaves the type list unconstrained: every type the feed runs', () => {
  assert.deepEqual(typesForAgencies(FEED, []), [0, 2, 3, 8]);
});

test('one operator narrows the types to the ones it runs', () => {
  assert.deepEqual(typesForAgencies(FEED, ['egged']), [3, 8]);
});

test('several operators contribute a deduped, ascending union', () => {
  assert.deepEqual(typesForAgencies(FEED, ['dan', 'cfir']), [0, 3]);
});

test('an operator id the feed does not know contributes nothing', () => {
  assert.deepEqual(typesForAgencies(FEED, ['dan', 'ghost']), [3]);
});

test('no type picked leaves the operator list unconstrained', () => {
  assert.deepEqual(agenciesForTypes(FEED, []), FEED);
});

test('one type keeps only the operators that run it, in feed order', () => {
  assert.deepEqual(
    agenciesForTypes(FEED, [3]).map((agency) => agency.agencyId),
    ['dan', 'egged', 'cfir'],
  );
});

test('several types keep the operators running at least one of them', () => {
  assert.deepEqual(
    agenciesForTypes(FEED, [0, 8]).map((agency) => agency.agencyId),
    ['egged', 'cfir'],
  );
});

// An empty selection means "no constraint", so there is nothing for the rider
// to have locked -- the type chip stays live even in a feed that happens to
// run a single kind of vehicle.
test('nothing is locked while no operator is picked', () => {
  assert.equal(lockedType(FEED, []), null);
  assert.equal(lockedType([{ agencyId: 'dan', types: [3] }], []), null);
});

test('an operator that runs one kind of vehicle locks that type', () => {
  assert.equal(lockedType(FEED, ['dan']), 3);
});

test('two operators that between them run only buses lock buses', () => {
  const buses: AgencyTypes[] = [
    { agencyId: 'dan', types: [3] },
    { agencyId: 'metropoline', types: [3] },
  ];
  assert.equal(lockedType(buses, ['dan', 'metropoline']), 3);
  // Two operators running different single types lock nothing.
  assert.equal(lockedType(FEED, ['dan', 'rail']), null);
});

test('an operator running more than one kind of vehicle locks nothing', () => {
  assert.equal(lockedType(FEED, ['egged']), null);
});

test('an operator left with no types at all locks nothing', () => {
  assert.equal(lockedType([{ agencyId: 'empty', types: [] }], ['empty']), null);
});

test('excluding a type strips it and drops operators left running nothing', () => {
  assert.deepEqual(excludeType(FEED, 2), [
    { agencyId: 'dan', types: [3] },
    { agencyId: 'egged', types: [3, 8] },
    { agencyId: 'cfir', types: [0, 3] },
  ]);
});

test('excluding a type the feed does not run leaves it untouched', () => {
  assert.deepEqual(excludeType(FEED, 715), FEED);
});

test('picking nothing sends no type constraint', () => {
  assert.deepEqual(effectiveTypes(FEED, [], []), []);
  assert.deepEqual(effectiveTypes(FEED, ['egged'], []), []);
});

test('a locked type overrides whatever the rider had picked before', () => {
  assert.deepEqual(effectiveTypes(FEED, ['dan'], [0, 8]), [3]);
});

test('types the picked operators do not run are dropped', () => {
  assert.deepEqual(effectiveTypes(FEED, ['egged'], [0, 3]), [3]);
});

// The drawers never offer a combination that leaves nothing, so this is the
// belt-and-braces case: fall back to no type constraint rather than sending
// one that can only return an empty list.
test('a selection the operators cannot satisfy falls back to no constraint', () => {
  assert.deepEqual(effectiveTypes(FEED, ['egged'], [0]), []);
});

test('with no operator picked the rider keeps their own types, ascending', () => {
  assert.deepEqual(effectiveTypes(FEED, [], [8, 0]), [0, 8]);
});
