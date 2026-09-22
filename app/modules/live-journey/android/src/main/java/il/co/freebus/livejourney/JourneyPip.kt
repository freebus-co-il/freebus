package il.co.freebus.livejourney

import android.app.Activity
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer

/**
 * Picture-in-picture for a running journey, on the app's own activity.
 *
 * There is no PiP activity of our own: the window IS the React tree, shrunk,
 * and JS swaps the navigator for a compact view while `onPipModeChanged` says
 * so. That keeps every word and colour in the one place the other surfaces
 * already get them from. This object only arms the OS, and says when it fired.
 */
object JourneyPip {
  /** Wide and short, like a notification: two lines of text and a big number,
   *  well inside the 2.39:1 the platform allows. */
  private val ASPECT_RATIO = Rational(2, 1)

  private var armed = false
  private var acknowledge = false
  private var listeningTo: ComponentActivity? = null
  private var listener: Consumer<PictureInPictureModeChangedInfo>? = null

  fun isSupported(activity: Activity?): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      activity?.packageManager?.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) == true

  fun isInPip(activity: Activity?): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity?.isInPictureInPictureMode == true

  /**
   * Arms or disarms auto-enter, and adds or drops the "Got it" action. On 12+
   * the OS enters by itself on the home gesture, which is also what makes the
   * transition smooth; below that `enterIfArmed` does it from the leave hint.
   */
  fun configure(activity: Activity?, armed: Boolean, acknowledge: Boolean, onModeChanged: (Boolean) -> Unit) {
    this.armed = armed
    this.acknowledge = acknowledge
    if (activity == null || !isSupported(activity)) return
    attach(activity, onModeChanged)
    activity.setPictureInPictureParams(params(activity))
  }

  fun enterIfArmed(activity: Activity?) {
    if (!armed || activity == null || !isSupported(activity)) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
    runCatching { activity.enterPictureInPictureMode(params(activity)) }
  }

  /** Puts the window away after arrival. The task goes to the background
   *  rather than finishing, so the next open is warm and the JS state intact. */
  fun leave(activity: Activity?) {
    if (activity != null && isInPip(activity)) activity.moveTaskToBack(false)
  }

  fun detach() {
    val activity = listeningTo
    val current = listener
    if (activity != null && current != null) activity.removeOnPictureInPictureModeChangedListener(current)
    listeningTo = null
    listener = null
  }

  private fun attach(activity: Activity, onModeChanged: (Boolean) -> Unit) {
    val component = activity as? ComponentActivity ?: return
    if (listeningTo === component) return
    detach()
    val next = Consumer<PictureInPictureModeChangedInfo> { info -> onModeChanged(info.isInPictureInPictureMode) }
    component.addOnPictureInPictureModeChangedListener(next)
    listeningTo = component
    listener = next
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun params(activity: Activity): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(ASPECT_RATIO)
      .setActions(if (acknowledge) listOf(acknowledgeAction(activity)) else emptyList())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(armed)
      // Text, not video: a seamless resize would stretch the words mid-animation.
      builder.setSeamlessResizeEnabled(false)
    }
    return builder.build()
  }

  /** The same intent as the notification's button, so "Got it" from the window
   *  silences the alert and reaches JS by exactly the same path. */
  @RequiresApi(Build.VERSION_CODES.O)
  private fun acknowledgeAction(activity: Activity): RemoteAction {
    val title = activity.getString(R.string.live_journey_got_it)
    return RemoteAction(
      Icon.createWithResource(activity, R.drawable.ic_live_journey_walk),
      title,
      title,
      JourneyService.acknowledgeIntent(activity),
    )
  }
}
