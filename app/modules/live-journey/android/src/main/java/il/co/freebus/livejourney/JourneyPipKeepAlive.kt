package il.co.freebus.livejourney

import android.app.Activity
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.lang.ref.WeakReference

/**
 * Keeps JS timers running while the journey is the PiP window.
 *
 * A PiP activity is paused while it is on screen, and React Native's
 * `JavaTimerManager` stops firing `setTimeout`/`setInterval` on `onHostPause`
 * -- unless a headless JS task is running, which is the one exception it
 * makes. Without this the window freezes on whatever it last drew: the
 * five-second journey clock, the live polls and the arrival timer all stop at
 * the exact moment the rider starts looking at them.
 *
 * So entering PiP starts a task with no timeout, and leaving PiP finishes it.
 * The JS half (`pip.ts`) is a task that simply waits for PiP to end; it does
 * no work of its own -- the point is only that a task is running.
 */
object JourneyPipKeepAlive {
  /** Must match `PIP_KEEP_ALIVE_TASK` in `src/features/journey/pip.ts`. */
  const val TASK_KEY = "FreebusJourneyPipKeepAlive"

  private const val TAG = "JourneyPipKeepAlive"

  private var taskId: Int? = null

  /** The context the task was started on, so it is finished on the same one
   *  even when no activity is left to find it through. Weak because the
   *  context must never be kept alive by a task bookkeeping field. */
  private var taskContext: WeakReference<ReactContext>? = null

  fun start(activity: Activity?) {
    UiThreadUtil.assertOnUiThread()
    if (taskId != null) return
    val reactContext = (activity?.application as? ReactApplication)?.reactHost?.currentReactContext ?: return
    runCatching {
      // Allowed in the foreground because the mode-change callback can land
      // before the activity has actually been paused, and the task context
      // refuses a foreground start otherwise. Timeout 0: the task ends when
      // PiP does, not on a clock.
      HeadlessJsTaskContext.getInstance(reactContext)
        .startTask(HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), 0L, true))
    }.onSuccess { id ->
      taskId = id
      taskContext = WeakReference(reactContext)
    }.onFailure {
      Log.w(TAG, "Could not keep JS timers alive in PiP; the window will not tick", it)
    }
  }

  fun stop() {
    val id = taskId ?: return
    val reactContext = taskContext?.get()
    taskId = null
    taskContext = null
    if (reactContext == null) return
    UiThreadUtil.runOnUiThread { HeadlessJsTaskContext.getInstance(reactContext).finishTask(id) }
  }
}
