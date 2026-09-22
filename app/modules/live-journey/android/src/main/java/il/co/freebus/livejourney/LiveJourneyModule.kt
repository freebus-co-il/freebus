package il.co.freebus.livejourney

import android.content.Context
import android.location.Location
import android.os.Bundle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The records below mirror the TypeScript types they are converted from, and
// deliberately declare only the fields the surface draws: an Expo `Record`
// ignores keys it was not asked for, so the whole `Itinerary` can cross the
// bridge inside `ActiveJourney` and cost nothing on this side. They are the
// Kotlin twins of the structs in ios/LiveJourneyModule.swift -- same names,
// same shapes, so a change to `LiveSurface` breaks both or neither.

/** A subset of `ActiveJourney` (src/features/journey/types.ts). */
class ActiveJourneyRecord : Record {
  @Field var id: String = ""

  @Field var destinationLabel: String = ""
}

class RouteRecord : Record {
  @Field var shortName: String = ""

  /** GTFS `route_type`, for the vehicle glyph a rail line needs because it
   *  has no number to print. */
  @Field var type: Int = 3
}

/**
 * A subset of `TransitLeg` (src/api/types.ts).
 *
 * The stop names and arrival times this used to carry are gone: the surface
 * prints `JourneySurfaceCopy`, and composing "Off at <stop>" here was the
 * `journey.offAt` key reimplemented in `strings.xml`. All that is left is the
 * leg's IDENTITY, which is a glyph rather than a sentence.
 */
class TransitLegRecord : Record {
  @Field var route: RouteRecord? = null
}

/** `JourneyState['timer']`. ISO-8601 strings; the notification turns the end
 *  of the range into `setWhen`, which the OS then ticks down on its own. */
class TimerRecord : Record {
  @Field var from: String = ""

  @Field var to: String = ""

  @Field var countsDown: Boolean = true
}

/** `JourneyState`. */
class JourneyStateRecord : Record {
  @Field var phase: String = ""

  @Field var legIndex: Int = 0

  @Field var leg: TransitLegRecord? = null

  @Field var stopsRemaining: Int? = null

  @Field var timer: TimerRecord? = null

  @Field var offPlan: String? = null

  @Field var progress: Double = 0.0
}

/** `RailSegment`. */
class RailSegmentRecord : Record {
  @Field var legIndex: Int = 0

  @Field var seconds: Double = 0.0

  @Field var color: String = "#666666"

  @Field var kind: String = "transit"
}

/** `RailPoint`. */
class RailPointRecord : Record {
  @Field var atSeconds: Double = 0.0
}

/** `JourneyRail`. */
class RailRecord : Record {
  @Field var totalSeconds: Double = 0.0

  @Field var segments: List<RailSegmentRecord> = emptyList()

  @Field var points: List<RailPointRecord> = emptyList()
}

/**
 * `JourneySurfaceCopy`. The two lines the notification prints, resolved
 * through react-i18next in `journey-copy.ts`.
 *
 * This is what retired the `journey.*` mirror that used to live in
 * `strings.xml` and `values-iw/strings.xml`. Two files saying the same things
 * in two languages, updated by hand, is a drift waiting to happen -- and
 * Hebrew is a first-class locale here, so it would have been a visible one.
 */
class JourneySurfaceCopyRecord : Record {
  @Field var hero: String = ""

  @Field var supporting: String? = null

  /** The colour of the thing the rider is currently on. Preferred over the
   *  rail segment for the notification's accent because on a transfer the
   *  copy is about the line being CAUGHT while the segment underfoot is the
   *  walk. */
  @Field var accent: String = ""

  /** "Live" / "Scheduled" beside a departure countdown, already translated.
   *  Empty when there is nothing to label. */
  @Field var liveLabel: String = ""
}

/** `LiveSurfaceAlert`. `title` and `body` arrive already resolved through
 *  react-i18next, which is how the notification shouts in Hebrew without
 *  knowing any. */
class LiveSurfaceAlertRecord : Record {
  @Field var title: String = ""

  @Field var body: String = ""

  @Field var sound: Boolean = true

  @Field var vibrate: Boolean = true
}

class NoActiveJourneyException :
  CodedException("update() was called with no journey running")

/**
 * The Android live surface: a foreground service hosting a `ProgressStyle`
 * notification.
 *
 * Registers as `LiveJourney`, the same name the iOS module registers under and
 * the name `src/features/journey/live-surface.ts` resolves -- one JS contract,
 * two renderers.
 */
class LiveJourneyModule : Module() {
  /**
   * The rail from `start`, kept because it is the ONLY place the resolved
   * route colours live. `JourneyState` carries the leg but not its colour --
   * colour is `routeColor(leg.route)`, an operator lookup this side must never
   * re-implement -- so every `update` reads the colour for its `legIndex` back
   * out of here.
   */
  private var rail: RailRecord? = null
  private var journey: ActiveJourneyRecord? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LiveJourney")

    Events("onAcknowledgeAlight", "onPipModeChanged", "onJourneyPosition")

    OnCreate {
      // The service has already cancelled the alert and stopped the haptic by
      // the time this runs; this only tells JS so the in-app surfaces agree.
      // That order is what makes acknowledging work with the app suspended.
      JourneyService.onAcknowledge = { sendEvent("onAcknowledgeAlight", Bundle()) }
    }

    OnDestroy {
      JourneyService.onAcknowledge = null
      JourneyPip.detach()
      JourneyPipLocation.stop()
      JourneyPipKeepAlive.stop()
    }

    AsyncFunction("start") { active: ActiveJourneyRecord,
                             state: JourneyStateRecord,
                             railArg: RailRecord,
                             copy: JourneySurfaceCopyRecord ->
      val context = context
      JourneyNotification.ensureChannels(context)
      rail = railArg
      journey = active
      JourneyService.start(context, JourneyNotification.build(context, active, state, railArg, copy))
    }

    AsyncFunction("update") { state: JourneyStateRecord,
                              copy: JourneySurfaceCopyRecord,
                              alert: LiveSurfaceAlertRecord? ->
      val railArg = rail ?: throw NoActiveJourneyException()
      val active = journey ?: throw NoActiveJourneyException()
      val context = context
      val notifications = NotificationManagerCompat.from(context)

      // Re-posting the same id updates the foreground notification in place,
      // which is what keeps the rail and the chip in step with the machine --
      // and, after a swipe, is also the only thing that could put it back.
      //
      // So the redraw is skipped once the rider has dismissed it, EXCEPT when
      // this update is spending an alert. Keying the exception on the alert
      // rather than on a list of phases is deliberate twice over: a second
      // phase table on this side of the bridge is exactly the drift the copy
      // contract was built to end, and "the surface returns for the moments it
      // exists for" is already the rule `alert` encodes. Anything else would
      // be reposting a dismissed Live Update on the platform's own schedule,
      // which is how an app earns having its live updates switched off.
      if (alert != null || !JourneyDismissReceiver.dismissed) {
        JourneyDismissReceiver.dismissed = false
        notifications.notify(
          JourneyNotification.ONGOING_ID,
          JourneyNotification.build(context, active, state, railArg, copy),
        )
      }

      // Passing an alert at all is JS spending one of the three moments in the
      // spec's alert budget. Everything else is a silent redraw.
      if (alert != null) {
        notifications.notify(
          JourneyNotification.ALERT_ID,
          JourneyNotification.buildAlert(context, alert),
        )
        if (alert.vibrate) JourneyNotification.vibrate(context)
      }
    }

    AsyncFunction("stop") {
      val context = context
      JourneyService.stop(context)
      // Cancelled explicitly rather than left to the service: the foreground
      // notification only dies with the service when the service actually got
      // to be one, and it may have degraded to a plain ongoing post.
      NotificationManagerCompat.from(context).cancel(JourneyNotification.ONGOING_ID)
      NotificationManagerCompat.from(context).cancel(JourneyNotification.ALERT_ID)
      JourneyNotification.stopVibrating(context)
      // The PiP position feed ends with the journey. The timer keep-alive does
      // not: the window lingers on "You're here" and its own timer puts it
      // away, which needs timers -- it ends when PiP does.
      JourneyPipLocation.stop()
      rail = null
      journey = null
    }

    // Picture-in-picture. Android only: JS never calls these on iOS, where
    // PiP is reserved for video and the Live Activity is the equivalent.
    Function("isPipAvailable") { JourneyPip.isSupported(appContext.currentActivity) }

    Function("isInPip") { JourneyPip.isInPip(appContext.currentActivity) }

    AsyncFunction("setPip") { armed: Boolean, acknowledge: Boolean ->
      JourneyPip.configure(appContext.currentActivity, armed, acknowledge) { inPip -> onPipModeChanged(inPip) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("leavePip") {
      JourneyPip.leave(appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)

    // Below Android 12 there is no auto-enter; the leave hint is the moment.
    OnUserLeavesActivity {
      JourneyPip.enterIfArmed(appContext.currentActivity)
    }
  }

  /**
   * The paused PiP activity gets none of what a resumed one does: React
   * Native stops JS timers and expo-location stops its watches. Both are put
   * back for exactly as long as the window is up -- the keep-alive BEFORE JS
   * hears about PiP, so the task exists by the time anything waits on it.
   * Called on the main thread by the mode-change listener.
   */
  private fun onPipModeChanged(inPip: Boolean) {
    if (inPip) {
      JourneyPipKeepAlive.start(appContext.currentActivity)
      appContext.reactContext?.let { context ->
        JourneyPipLocation.start(context) { fix -> sendEvent("onJourneyPosition", positionBundle(fix)) }
      }
    } else {
      JourneyPipLocation.stop()
      JourneyPipKeepAlive.stop()
    }
    sendEvent("onPipModeChanged", Bundle().apply { putBoolean("inPip", inPip) })
  }

  /** `RiderPosition` (src/features/journey/types.ts). A fix without a stated
   *  accuracy is sent without one, and JS reads that as the worst accuracy it
   *  will still act on rather than as a perfect one. */
  private fun positionBundle(fix: Location): Bundle = Bundle().apply {
    putDouble("lat", fix.latitude)
    putDouble("lon", fix.longitude)
    if (fix.hasAccuracy()) putDouble("accuracyMeters", fix.accuracy.toDouble())
    putString("at", isoFormat().format(Date(fix.time)))
  }

  /** ISO-8601 in UTC, the shape every other time in the journey has.
   *  `java.time` would need API 26; this module still runs below it. */
  private fun isoFormat() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }
}
