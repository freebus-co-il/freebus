import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HEADS_UP_SECONDS,
  newReminderId,
  parsePendingLeave,
  pendingIdFromNotificationData,
  planLeaveReminders,
  shouldOfferReminder,
  type PendingLeave,
} from './leave-reminder';

const NOW = new Date('2026-09-16T09:00:00.000Z');

function pending(departure: string): PendingLeave {
  return {
    id: 'r123',
    // Only `legs` is ever read off the itinerary by the code under test.
    itinerary: { legs: [] } as unknown as PendingLeave['itinerary'],
    signature: 'sig',
    departure,
    destinationLabel: 'Home',
    setAt: NOW.toISOString(),
  };
}

test('a trip an hour out is offered a reminder', () => {
  assert.equal(shouldOfferReminder('2026-09-16T10:00:00.000Z', NOW), true);
});

// The rider is holding the phone that would buzz: starting is the better
// answer, so the button stays Start.
test('a trip leaving within two minutes is not', () => {
  assert.equal(shouldOfferReminder('2026-09-16T09:01:00.000Z', NOW), false);
  assert.equal(shouldOfferReminder('2026-09-16T08:50:00.000Z', NOW), false);
});

test('an unparseable departure is never offered a reminder', () => {
  assert.equal(shouldOfferReminder('not a time', NOW), false);
});

test('an hour out schedules the leave alert and a heads-up ten minutes before it', () => {
  const planned = planLeaveReminders(pending('2026-09-16T10:00:00.000Z'), NOW);
  assert.deepEqual(
    planned.map((r) => [r.kind, r.fireAt, r.minutesBefore]),
    [
      ['leave', '2026-09-16T10:00:00.000Z', 0],
      ['headsUp', '2026-09-16T09:50:00.000Z', HEADS_UP_SECONDS / 60],
    ],
  );
  // Prefixed by the record's id, so the pair cancels by prefix like the
  // get-off alerts do.
  assert.deepEqual(planned.map((r) => r.id), ['r123:leave', 'r123:headsup']);
});

// Two notifications a few minutes apart read as a stutter, not as news.
test('a trip fifteen minutes out gets the leave alert alone', () => {
  const planned = planLeaveReminders(pending('2026-09-16T09:15:00.000Z'), NOW);
  assert.deepEqual(planned.map((r) => r.kind), ['leave']);
});

// A date trigger in the past fires immediately -- which would shout "time to
// leave" as the rider set the reminder.
test('reminders already in the past are dropped, not scheduled', () => {
  assert.deepEqual(planLeaveReminders(pending('2026-09-16T08:00:00.000Z'), NOW), []);
});

test('a reminder id carries no colon, which its notification ids separate on', () => {
  assert.ok(!newReminderId(NOW).includes(':'));
});

test('a tapped notification yields the record id it points at, and nothing else does', () => {
  assert.equal(pendingIdFromNotificationData({ pendingId: 'r123' }), 'r123');
  assert.equal(pendingIdFromNotificationData({ pendingId: '' }), null);
  assert.equal(pendingIdFromNotificationData({ other: 'r123' }), null);
  assert.equal(pendingIdFromNotificationData(null), null);
  assert.equal(pendingIdFromNotificationData('r123'), null);
});

test('a half-written stored record reads as no reminder at all', () => {
  const good = pending('2026-09-16T10:00:00.000Z');
  assert.deepEqual(parsePendingLeave(good), good);
  assert.equal(parsePendingLeave({ ...good, itinerary: {} }), null);
  assert.equal(parsePendingLeave({ ...good, id: '' }), null);
  assert.equal(parsePendingLeave({ ...good, departure: undefined }), null);
  assert.equal(parsePendingLeave(null), null);
});
