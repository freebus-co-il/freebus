package il.co.freebus.livejourney

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * How the module hears that the rider swiped the rail off their lock screen.
 *
 * Android 13 took away the app's ability to refuse. `setOngoing(true)` no
 * longer pins a foreground service's notification, and the two exemptions the
 * platform still grants -- a notification bound to an active `MediaSession`,
 * and a self-managed call -- both require claiming to be something a journey
 * is not. Registering a media session to win the swipe would put Freebus in
 * the volume slider, on car head units and in the output picker, arguing with
 * the rider's actual music for the length of the trip.
 *
 * So the rail is dismissable, and the only thing left to get right is what
 * happens after: the service keeps the rider's position and the get-off alarm
 * -- neither is drawn by this notification -- and stops redrawing a surface
 * they just told us to put away.
 *
 * A receiver rather than the `PendingIntent.getService` that
 * `JourneyService.acknowledgeIntent` uses. That one is delivered to a service
 * that is alive by construction: the button only exists on a notification the
 * service is holding up. A delete intent has no such guarantee -- the
 * notification outlives the service on the degraded path in
 * `JourneyService.adopt` -- and `startService` from the background is refused
 * outright from Android 12. A broadcast has neither restriction, and a
 * manifest-declared one has nothing to register, unregister or leak.
 */
class JourneyDismissReceiver : BroadcastReceiver() {
  companion object {
    private const val ACTION_DISMISSED = "il.co.freebus.livejourney.DISMISSED"

    /**
     * Set by a swipe; cleared when a journey starts, stops, or reaches the one
     * moment worth reappearing for. Read by `LiveJourneyModule.update`.
     *
     * Static because the writer and the reader do not share a lifetime: a
     * receiver is constructed for a single callback and thrown away, and the
     * JS runtime that later reads this may not have existed when it fired.
     */
    @Volatile
    var dismissed: Boolean = false

    /** Request code 2 keeps this distinct from `openApp` (0) and
     *  `acknowledgeIntent` (1), so no two of them can collapse into one. */
    fun deleteIntent(context: Context): PendingIntent =
      PendingIntent.getBroadcast(
        context,
        2,
        Intent(context, JourneyDismissReceiver::class.java).setAction(ACTION_DISMISSED),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
  }

  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != ACTION_DISMISSED) return
    dismissed = true
  }
}
