import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scrubEvent, scrubText } from './crash-scrub';

test('a URL keeps its host and the shape of its path, and loses ids, query and fragment', () => {
  assert.equal(
    scrubText('Request failed: https://api.freebus.co.il/stops/21563/departures?lat=32.0853&lon=34.7818#top'),
    'Request failed: https://api.freebus.co.il/stops/:id/departures',
  );
});

test('numbers of two or more digits become #, so no stop, line or coordinate survives', () => {
  assert.equal(scrubText('no departures for line 480 at 32.0853,34.7818'), 'no departures for line # at #,#');
  assert.equal(scrubText('index 3 out of range'), 'index 3 out of range');
});

test('a quoted code identifier is kept, quoted free text is not', () => {
  assert.equal(scrubText("Cannot read property 'stops' of undefined"), "Cannot read property 'stops' of undefined");
  assert.equal(
    scrubText('Unexpected token "herzl st tel aviv" is not valid JSON'),
    'Unexpected token "…" is not valid JSON',
  );
});

test('Hebrew and other non-Latin words are removed, quoted or not', () => {
  assert.equal(scrubText('no stop named תחנה מרכזית found'), 'no stop named … found');
  assert.equal(scrubText("place 'רחוב הרצל' missing"), "place '…' missing");
});

test('an event loses the user, request, breadcrumbs, extra and any context not on the allowlist', () => {
  const scrubbed = scrubEvent({
    type: undefined,
    user: { id: 'installation-uuid' },
    request: { url: 'https://api.freebus.co.il/plan?from=32.1,34.8' },
    breadcrumbs: [{ message: 'GET /plan?from=32.1,34.8' }],
    extra: { search: 'herzl' },
    server_name: 'iPhone',
    transaction: '/station/21563',
    message: 'search for 32.0853 failed',
    exception: { values: [{ type: 'TypeError', value: 'bad stop 21563' }] },
    contexts: {
      device: { model: 'iPhone16,1', family: 'iOS', simulator: false, name: "Dana's iPhone", timezone: 'Asia/Jerusalem' },
      os: { name: 'iOS', version: '26.1', build: '23B85' },
      app: { app_version: '1.0.5', app_build: '42', app_start_time: '2026-10-24T08:00:00Z', in_foreground: true },
      ota_updates: { update_id: 'abc', channel: 'production' },
      culture: { locale: 'he-IL', timezone: 'Asia/Jerusalem' },
      trace: { trace_id: 'x', span_id: 'y' },
    },
  });

  assert.equal(scrubbed.user, undefined);
  assert.equal(scrubbed.request, undefined);
  assert.equal(scrubbed.breadcrumbs, undefined);
  assert.equal(scrubbed.extra, undefined);
  assert.equal(scrubbed.server_name, undefined);
  assert.equal(scrubbed.transaction, undefined);
  assert.equal(scrubbed.message, 'search for # failed');
  assert.deepEqual(scrubbed.exception?.values?.[0], { type: 'TypeError', value: 'bad stop #' });
  assert.deepEqual(scrubbed.contexts, {
    device: { model: 'iPhone16,1', family: 'iOS', simulator: false },
    os: { name: 'iOS', version: '26.1', build: '23B85' },
    app: { app_version: '1.0.5', app_build: '42', in_foreground: true },
    ota_updates: { update_id: 'abc', channel: 'production' },
  });
});

test('an exception without a message stays without one', () => {
  const scrubbed = scrubEvent({ type: undefined, exception: { values: [{ type: 'Error' }] } });
  assert.deepEqual(scrubbed.exception?.values?.[0], { type: 'Error' });
});
