import type { Itinerary } from '@/api/types';

/**
 * A journey the rider has asked to be reminded about, waiting for its leave
 * time. Not an `ActiveJourney`: nothing is running, no geofence is armed and
 * no get-off alarm is scheduled -- this is only a promise to shout later.
 *
 * The WHOLE itinerary is kept, exactly as `ActiveJourney` keeps it, and for
 * the same reason turned sharper by the hour that passes here: `signature`
 * plus `departure` only addresses the plan cache, and an hour later that
 * cache is gone. Storing the itinerary is what makes the reminder start the
 * journey the rider actually chose rather than whatever a fresh search
 * returns.
 */
export type PendingLeave = {
  id: string;
  itinerary: Itinerary;
  /** Mirrors `ActiveJourney.signature` -- handed straight through to `start`
   *  so the running journey addresses the plan cache the same way. */
  signature: string;
  /** The itinerary's own departure: when the rider has to LEAVE, walk
   *  included, which is what the trip screen counts down to. */
  departure: string;
  destinationLabel: string;
  setAt: string;
};

/**
 * Nearer than this and "remind me" is a worse answer than starting: the
 * reminder would land while the rider is still looking at the screen they set
 * it on.
 */
export const REMINDER_MIN_LEAD_SECONDS = 120;

/** The heads-up, far enough ahead to put shoes on. */
export const HEADS_UP_SECONDS = 600;

/**
 * Below this there is no room for two notifications -- a heads-up and the
 * leave alert would arrive almost together, which reads as the app stuttering
 * rather than as two pieces of news.
 */
export const HEADS_UP_MIN_LEAD_SECONDS = 1_200;

/**
 * Whether this trip is far enough away that the rider should be offered a
 * reminder instead of a Start button.
 */
export function shouldOfferReminder(departure: string, now: Date): boolean {
  const leadSeconds = (new Date(departure).getTime() - now.getTime()) / 1000;
  return Number.isFinite(leadSeconds) && leadSeconds >= REMINDER_MIN_LEAD_SECONDS;
}

export type PlannedReminder = {
  /** The notification's identifier. Prefixed with the record's id so the pair
   *  can be cancelled by prefix, as the get-off alerts are. */
  id: string;
  kind: 'leave' | 'headsUp';
  fireAt: string;
  /** Minutes of warning this one gives; the heads-up prints it. */
  minutesBefore: number;
};

/**
 * The notifications to schedule for one pending journey: the leave alert, and
 * a heads-up before it when the trip is far enough out.
 *
 * Anything already in the past is dropped rather than scheduled -- a date
 * trigger in the past fires at once, which would shout "time to leave" the
 * instant the rider set the reminder.
 */
export function planLeaveReminders(pending: PendingLeave, now: Date): PlannedReminder[] {
  const departureMs = new Date(pending.departure).getTime();
  if (!Number.isFinite(departureMs)) return [];
  const leadSeconds = (departureMs - now.getTime()) / 1000;

  const planned: PlannedReminder[] = [
    {
      id: `${pending.id}:leave`,
      kind: 'leave',
      fireAt: new Date(departureMs).toISOString(),
      minutesBefore: 0,
    },
  ];

  if (leadSeconds >= HEADS_UP_MIN_LEAD_SECONDS) {
    planned.push({
      id: `${pending.id}:headsup`,
      kind: 'headsUp',
      fireAt: new Date(departureMs - HEADS_UP_SECONDS * 1000).toISOString(),
      minutesBefore: HEADS_UP_SECONDS / 60,
    });
  }

  return planned.filter((reminder) => new Date(reminder.fireAt).getTime() > now.getTime());
}

/**
 * Colons separate a reminder's notification ids (`<id>:leave`), so the id
 * itself must not contain one -- the same rule as a journey's id, for the
 * same prefix-matching reason.
 */
export function newReminderId(now: Date = new Date()): string {
  return `r${now.getTime().toString(36)}`;
}

/** What a reminder notification carries, so the tap can find its record. */
export type ReminderPayload = { pendingId: string };

export function reminderPayload(pending: PendingLeave): ReminderPayload {
  return { pendingId: pending.id };
}

/**
 * The record id a tapped notification points at, or null when the tap was
 * about anything else (a get-off alert, a notification from an older build).
 * Read defensively: this arrives from the OS, across app launches.
 */
export function pendingIdFromNotificationData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as { pendingId?: unknown }).pendingId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Parsed the way the active journey is: a half-written or older-shaped record
 * means "no reminder is set", never a crash on launch. `itinerary.legs` is
 * the field checked because every consumer indexes into it.
 */
export function parsePendingLeave(raw: unknown): PendingLeave | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as PendingLeave;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.departure !== 'string') return null;
  if (!Array.isArray(record.itinerary?.legs)) return null;
  return record;
}
