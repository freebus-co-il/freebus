import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useJourney } from './journey-context';
import { pendingIdFromNotificationData } from './leave-reminder';

/**
 * Starts the journey a tapped leave reminder points at.
 *
 * Renders nothing, and sits beside `ShareIntentGate` for the same reason: a
 * notification tap arrives through the OS rather than through a URL, so
 * something mounted has to notice. `useLastNotificationResponse` covers the
 * hard case -- the tap that COLD-STARTS the app, where the response is
 * already spent by the time any component mounts.
 *
 * The id in the notification is what makes this start the right trip: the
 * record it names holds the whole itinerary the rider chose an hour ago, and
 * a tap whose id matches nothing does nothing at all rather than falling back
 * to some other journey.
 */
export function LeaveReminderGate() {
  const { startPending, hydrated } = useJourney();
  const response = Notifications.useLastNotificationResponse();
  // `router` throws before the navigator mounts, which on a cold start
  // launched BY the reminder is exactly when this first fires.
  const navigationReady = useRootNavigationState()?.key != null;
  /** Ids already acted on: the hook keeps reporting the same response for the
   *  life of the process, so without this every re-render would restart it. */
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!response || !navigationReady || !hydrated) return;

    const identifier = response.notification.request.identifier;
    if (handled.current.has(identifier)) return;

    const pendingId = pendingIdFromNotificationData(
      response.notification.request.content.data,
    );
    // Not a leave reminder -- a get-off alert, or a notification from a build
    // older than this feature.
    if (pendingId === null) return;

    handled.current.add(identifier);
    void startPending(pendingId).then((started) => {
      // A record that is gone (the rider already started it, or cleared it)
      // leaves them where they were rather than opening an empty journey.
      if (started) router.replace('/journey');
    });
  }, [response, navigationReady, hydrated, startPending]);

  return null;
}
