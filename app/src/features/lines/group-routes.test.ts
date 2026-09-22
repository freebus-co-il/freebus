import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupRoutes, lineCodeOf, lineKeyOf } from './group-routes';

const row = (
  routeId: string, shortName: string | null, desc: string | null,
  agencyId = '2', type = 3, longName: string | null = null,
) => ({ routeId, shortName, longName, agencyId, type, desc, color: null });

test('lineCodeOf takes the text before the first dash', () => {
  assert.equal(lineCodeOf('67001-1-#'), '67001');
  assert.equal(lineCodeOf('34001-1-א'), '34001');
});

test('lineCodeOf returns the whole value when there is no dash', () => {
  // Rail rows carry a bare number and no line identity at all.
  assert.equal(lineCodeOf('900'), '900');
});

test('lineCodeOf returns null only for a null desc', () => {
  assert.equal(lineCodeOf(null), null);
});

test('lineKeyOf is the line code for a dashed desc and the route id otherwise', () => {
  assert.equal(lineKeyOf({ desc: '67001-1-#', routeId: '1' }), '67001');
  // Rail: the bare desc is shared by other services, so it cannot be a key.
  assert.equal(lineKeyOf({ desc: '900', routeId: '29950' }), 'route:29950');
  assert.equal(lineKeyOf({ desc: null, routeId: '29950' }), 'route:29950');
});

test('keeps two rail rows that share a desc as two lines', () => {
  // 32 undashed descs in the real feed are carried by two route rows each,
  // and they are genuinely different services. Merging them would make one
  // of the two unreachable.
  const lines = groupRoutes([
    row('38450', '', '1', '2', 2, 'נהריה<->נתב״ג'),
    row('44031', '', '1', '2', 2, 'נהריה<->מודיעין מרכז'),
  ]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.lineCode), ['route:38450', 'route:44031']);
  assert.deepEqual(lines.map((l) => l.longName), ['נהריה<->נתב״ג', 'נהריה<->מודיעין מרכז']);
});

test('groups both directions of one line into a single entry', () => {
  const lines = groupRoutes([row('1', '1', '67001-1-#'), row('2', '1', '67001-2-#')]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.lineCode, '67001');
  assert.equal(lines[0]!.shortName, '1');
  assert.deepEqual(lines[0]!.routeIds, ['1', '2']);
});

test('keeps lines with the same short name but different codes apart', () => {
  // 116 routes in the real feed are called "1". They are not one line.
  const lines = groupRoutes([
    row('1', '1', '67001-1-#', '25'),
    row('10379', '1', '34001-1-ד', '38'),
    row('10746', '1', '73001-1-0', '21'),
  ]);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.lineCode), ['67001', '34001', '73001']);
});

test('collapses same-direction alternatives into one line', () => {
  // Line 34001 direction 1 is three rows in the real feed.
  const lines = groupRoutes([
    row('10379', '1', '34001-1-ד'),
    row('10381', '1', '34001-1-ו'),
    row('10383', '1', '34001-1-ח'),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.routeIds.length, 3);
});

test('labels a rail row by its long name when it has no short name', () => {
  const lines = groupRoutes([row('29950', '', '100', '2', 2, 'נהריה<->מודיעין')]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.shortName, null);
  assert.equal(lines[0]!.longName, 'נהריה<->מודיעין');
});

test('merges a line whose rows straddle a page boundary', () => {
  // The tab groups over the ACCUMULATED list, so appending page two must
  // fold the second direction into the line page one already produced --
  // not add a second line.
  const page1 = [row('1', '1', '67001-1-#')];
  const page2 = [row('2', '1', '67001-2-#')];
  const lines = groupRoutes([...page1, ...page2]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0]!.routeIds, ['1', '2']);
});

test('preserves first-seen order', () => {
  const lines = groupRoutes([row('9', '9', '99001-1-0'), row('1', '1', '11001-1-0')]);
  assert.deepEqual(lines.map((l) => l.lineCode), ['99001', '11001']);
});

// A deployed API that predates the `desc` field sends route rows without it.
// The app ships separately from the single self-hosted box it talks to, so
// "the server is older than the client" is a normal state, not an error --
// and it must not crash the Lines tab.
test('lineCodeOf tolerates a desc the server never sent', () => {
  assert.equal(lineCodeOf(undefined as unknown as string | null), null);
});

test('groupRoutes still keys rows from a server too old to send desc', () => {
  // Such rows cannot be grouped into public lines -- without a desc there is
  // no line code to group ON -- but they are still individually addressable
  // by route id, so each becomes its own entry rather than vanishing. A list
  // of ungrouped directions is a far better degradation than an empty tab.
  const stale = [
    { routeId: '1', shortName: '1', longName: null, agencyId: '2', type: 3 },
    { routeId: '2', shortName: '2', longName: null, agencyId: '2', type: 3 },
  ] as unknown as Parameters<typeof groupRoutes>[0];
  const lines = groupRoutes(stale);
  assert.deepEqual(lines.map((l) => l.lineCode), ['route:1', 'route:2']);
});
