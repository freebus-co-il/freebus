package il.co.freebus.livejourney

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import java.lang.ref.WeakReference

/**
 * Keeps the React tree drawing while the journey is the PiP window.
 *
 * The keep-alive (`JourneyPipKeepAlive`) gets JS running in the paused
 * activity, but running is not drawing: Fabric's `onHostPause` stops the frame
 * callback that applies committed renders to the views, so `JourneyPip` is
 * rendered in JS and never mounted. The window shows whatever the activity drew
 * last -- the map -- for as long as PiP lasts.
 *
 * So entering PiP resumes Fabric's frame callback, and leaving PiP pauses it
 * again unless the activity came back to the front, where the activity's own
 * resume owns it. The resume is re-applied after every pause while in PiP,
 * because the mode-change callback can land BEFORE the activity is paused, and
 * React's pause would otherwise undo it straight away.
 */
object JourneyPipMounting {
  private val main = Handler(Looper.getMainLooper())

  private var observed: WeakReference<ComponentActivity>? = null

  /** Posted rather than run inline: the lifecycle reports ON_PAUSE before the
   *  activity's own `onPause` -- the one that pauses React -- has run. */
  private val observer = LifecycleEventObserver { source, event ->
    if (event == Lifecycle.Event.ON_PAUSE) main.post { setMounting(source as? Activity, true) }
  }

  fun start(activity: Activity?) {
    val component = activity as? ComponentActivity ?: return
    stop(null)
    component.lifecycle.addObserver(observer)
    observed = WeakReference(component)
    main.post { setMounting(component, true) }
  }

  fun stop(activity: Activity?) {
    observed?.get()?.lifecycle?.removeObserver(observer)
    observed = null
    val component = activity as? ComponentActivity ?: return
    // Back in front means React resumed on its own; pausing here would freeze
    // the full-size app instead of tidying up after the window.
    if (!component.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) setMounting(component, false)
  }

  private fun setMounting(activity: Activity?, enabled: Boolean) {
    val reactContext = (activity?.application as? ReactApplication)?.reactHost?.currentReactContext ?: return
    val fabric = UIManagerHelper.getUIManager(reactContext, UIManagerType.FABRIC) as? LifecycleEventListener ?: return
    if (enabled) fabric.onHostResume() else fabric.onHostPause()
  }
}
