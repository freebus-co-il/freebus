import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import i18n from '@/i18n';

import { parsePendingLeave, planLeaveReminders, reminderPayload, type PendingLeave } from './leave-reminder';

const STORAGE_KEY = 'freebus.pendingLeave.v1';

/** The reminder's own Android channel: it is ordinary news, unlike the
 *  get-off alarm's MAX-importance channel, and a channel's settings are
 *  frozen when it is first created -- so the two must not share one. */
const REMINDER_CHANNEL_ID = 'freebus.journey.leave';

/** Read the way the active journey is (see `journey-context`): a half-written
 *  or older-shaped record means "no reminder is set", never a crash. */
export async function readPendingLeave(): Promise<PendingLeave | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parsePendingLeave(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writePendingLeave(pending: PendingLeave | null): Promise<void> {
  try {
    if (pending) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // A reminder that cannot be persisted still fires -- the notification is
    // the OS's now. What is lost is the cold-start tap finding its itinerary,
    // which the tap handles by saying so rather than starting the wrong trip.
  }
}

function reminderBody(pending: PendingLeave): string {
  return pending.destinationLabel
    ? i18n.t('journey.reminder.body', { destination: pending.destinationLabel })
    : i18n.t('journey.reminder.bodyNoDestination');
}

/**
 * Arms the leave alert and its heads-up.
 *
 * Returns false when the rider refuses notification permission -- a reminder
 * nobody will ever see must not be saved as though it were set, or the trip
 * screen would promise a buzz that cannot come.
 */
export async function scheduleLeaveReminders(pending: PendingLeave, now: Date = new Date()): Promise<boolean> {
  const planned = planLeaveReminders(pending, now);
  if (planned.length === 0) return false;

  try {
    const permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true },
    });
    if (!permission.granted) return false;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
        name: i18n.t('journey.reminder.leaveTitle'),
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        showBadge: false,
      });
    }

    await Promise.all(
      planned.map((reminder) =>
        Notifications.scheduleNotificationAsync({
          identifier: reminder.id,
          content: {
            title: reminder.kind === 'leave'
              ? i18n.t('journey.reminder.leaveTitle')
              : i18n.t('journey.reminder.headsUpTitle', { minutes: reminder.minutesBefore }),
            body: reminderBody(pending),
            sound: 'default',
            // What the tap reads to find this exact journey -- see
            // `pendingIdFromNotificationData`.
            data: reminderPayload(pending),
            interruptionLevel: 'timeSensitive',
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(reminder.fireAt),
            channelId: REMINDER_CHANNEL_ID,
          },
        }),
      ),
    );
    return true;
  } catch {
    // No scheduler here (web, Expo Go). Nothing is armed, so nothing may be
    // promised.
    return false;
  }
}

/** Cancels both of a reminder's notifications, by the prefix they share --
 *  which works from a cold start, where nothing but storage survived. */
export async function cancelLeaveReminders(pendingId: string): Promise<void> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((request) => request.identifier.startsWith(`${pendingId}:`))
        .map((request) => Notifications.cancelScheduledNotificationAsync(request.identifier)),
    );
  } catch {
    // No scheduler, or no permission -- either way nothing is pending.
  }
}
