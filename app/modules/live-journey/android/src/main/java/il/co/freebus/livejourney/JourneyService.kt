package il.co.freebus.livejourney

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The process that owns a running journey.
 *
 * It exists for two reasons that are really one: a `location`-typed foreground
 * service is what legitimises background location to the OS, and its permanent
 * notification is what legitimises it to the rider. Neither is a technicality
 * -- the get-off alert is the feature, and it needs the rider's position while
 * their phone is in a pocket.
 */
class JourneyService : Service() {
  companion object {
    private const val TAG = "JourneyService"

    const val ACTION_START = "il.co.freebus.livejourney.START"
    const val ACTION_ACKNOWLEDGE = "il.co.freebus.livejourney.ACKNOWLEDGE"

    /**
     * Handed over rather than rebuilt here: the notification is built from the
     * `JourneyState` the module holds, and a `Service` started by an `Intent`
     * has no way to carry a nested record graph through `Bundle`s without
     * re-implementing every field. Set immediately before the start request.
     */
    @Volatile
    private var pending: Notification? = null

    /**
     * Set by `LiveJourneyModule` so JS hears the rider tap "Got it". Null when
     * the JS runtime is gone -- which is ordinary, not exceptional: the whole
     * point of acknowledging from the lock screen is that it works with the
     * app suspended, so the loud part stops here whether anyone is listening
     * or not.
     */
    @Volatile
    var onAcknowledge: (() -> Unit)? = null

    fun start(context: Context, notification: Notification) {
      pending = notification
      // A swipe is remembered for one journey, never past it: the next trip
      // starts with its rail on screen no matter what happened on the last.
      JourneyDismissReceiver.dismissed = false
      ContextCompat.startForegroundService(
        context,
        Intent(context, JourneyService::class.java).setAction(ACTION_START),
      )
    }

    fun stop(context: Context) {
      pending = null
      JourneyDismissReceiver.dismissed = false
      context.stopService(Intent(context, JourneyService::class.java))
    }

    /** Delivered to the service rather than to a receiver: the service is
     *  alive for exactly as long as the notification showing this button is,
     *  so there is nothing to register, unregister, or leak. */
    fun acknowledgeIntent(context: Context): PendingIntent =
      PendingIntent.getService(
        context,
        1,
        Intent(context, JourneyService::class.java).setAction(ACTION_ACKNOWLEDGE),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_ACKNOWLEDGE -> acknowledge()
      else -> adopt()
    }
    // The journey is a document, not a background job: if Android kills this
    // process the rider's plan is still in AsyncStorage and the app rebuilds
    // the surface on next launch. Restarting the service with a null intent
    // would only put an empty notification back on their lock screen.
    return START_NOT_STICKY
  }

  private fun adopt() {
    val notification = pending
    if (notification == null) {
      stopSelf()
      return
    }

    try {
      ServiceCompat.startForeground(
        this,
        JourneyNotification.ONGOING_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      )
    } catch (error: Exception) {
      // A location-typed foreground service is refused outright when the
      // location runtime permission is missing or the app is not allowed to
      // start one from where it is. Degrade to a plain ongoing notification
      // rather than taking the journey down with it: the rail is still worth
      // drawing, and the get-off alert has a second trigger -- a pre-scheduled
      // local notification -- that needs no process of ours at all.
      Log.w(TAG, "Foreground service refused; falling back to a plain ongoing notification", error)
      notify(JourneyNotification.ONGOING_ID, notification)
      stopSelf()
    }
  }

  private fun acknowledge() {
    // Silence first, tell JS after. The rider pressed a button to make the
    // noise stop, and that must not wait on a JS runtime that may not exist.
    JourneyNotification.stopVibrating(this)
    NotificationManagerCompat.from(this).cancel(JourneyNotification.ALERT_ID)
    // The rail itself is redrawn by the next `update()`: acknowledging moves
    // the machine out of `alight-soon`, which is a phase change, which is
    // exactly when the context spends an update.
    runCatching { onAcknowledge?.invoke() }
      .onFailure { Log.w(TAG, "Nobody was listening for the acknowledgement", it) }
  }

  private fun notify(id: Int, notification: Notification) {
    // POST_NOTIFICATIONS is requested on the JS side; without it the post is
    // dropped silently, which is the correct outcome for a rider who said no.
    runCatching { NotificationManagerCompat.from(this).notify(id, notification) }
      .onFailure { Log.w(TAG, "Notification refused", it) }
  }
}
