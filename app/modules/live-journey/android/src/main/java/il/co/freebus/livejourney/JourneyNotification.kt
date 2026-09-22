package il.co.freebus.livejourney

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.graphics.drawable.IconCompat
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The Android half of the live surface: one ongoing notification that draws
 * the journey rail, and one loud notification that shouts at the alight stop.
 *
 * Draws a `JourneyState` and prints a `JourneySurfaceCopy`, and decides
 * nothing -- the phase logic lives in `journey-machine.ts` and every word in
 * `journey-copy.ts`, so this and the SwiftUI widget cannot drift into
 * disagreeing about the same journey, or into two vocabularies for it.
 */
object JourneyNotification {
  /** Quiet enough to sit in the shade all journey, loud enough to still be
   *  promotable: IMPORTANCE_MIN disqualifies a notification from the chip. */
  const val ONGOING_CHANNEL_ID = "freebus.journey.ongoing"
  const val ALERT_CHANNEL_ID = "freebus.journey.alert"

  const val ONGOING_ID = 8321

  /**
   * The alert is a SEPARATE notification rather than a re-post of the ongoing
   * one. A notification cannot change channel, and the ongoing one lives on a
   * deliberately quiet channel -- so the only way to break through Do Not
   * Disturb at the alight stop is a second notification on a loud one. This
   * mirrors the parallel `UNNotificationRequest` the iOS side sends alongside
   * its Live Activity alert.
   */
  const val ALERT_ID = 8322

  /**
   * Long-short-long-long. Deliberately not the OS default: someone who has
   * dozed off has to recognise this through a coat pocket, and a pattern they
   * feel for every message would not do it.
   */
  val ALERT_VIBRATION_PATTERN = longArrayOf(0, 450, 180, 220, 180, 700)

  /** Mirror of `JourneyPhase` in src/features/journey/types.ts. */
  private const val PHASE_WALKING_TO_STOP = "walking-to-stop"
  private const val PHASE_WAITING = "waiting"
  private const val PHASE_RIDING = "riding"
  private const val PHASE_ALIGHT_SOON = "alight-soon"
  private const val PHASE_TRANSFERRING = "transferring"
  private const val PHASE_ARRIVING = "arriving"
  private const val PHASE_ARRIVED = "arrived"
  private const val PHASE_OFF_PLAN = "off-plan"

  /** `Notification.ProgressStyle`, `setShortCriticalText` and
   *  `setRequestPromotedOngoing` all land in Android 16. */
  private const val LIVE_UPDATE_SDK = Build.VERSION_CODES.BAKLAVA

  private const val FALLBACK_COLOR = "#666666"

  fun ensureChannels(context: Context) {
    val ongoing = NotificationChannelCompat.Builder(
      ONGOING_CHANNEL_ID,
      NotificationManager.IMPORTANCE_LOW,
    )
      .setName(context.getString(R.string.live_journey_channel_ongoing))
      .setDescription(context.getString(R.string.live_journey_channel_ongoing_description))
      .setShowBadge(false)
      .setVibrationEnabled(false)
      .build()

    // USAGE_ALARM rather than USAGE_NOTIFICATION on purpose: this is the one
    // moment in the spec's alert budget that is allowed to behave like an
    // alarm clock, and the alarm stream is the one the rider has not muted.
    val alert = NotificationChannelCompat.Builder(
      ALERT_CHANNEL_ID,
      NotificationManager.IMPORTANCE_HIGH,
    )
      .setName(context.getString(R.string.live_journey_channel_alert))
      .setDescription(context.getString(R.string.live_journey_channel_alert_description))
      .setVibrationEnabled(true)
      .setVibrationPattern(ALERT_VIBRATION_PATTERN)
      .setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
          ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      .build()

    NotificationManagerCompat.from(context).createNotificationChannelsCompat(listOf(ongoing, alert))
  }

  /**
   * The ongoing notification: the rail, the hero, and the status-bar chip.
   *
   * `rail` is the one captured at `start` and is the ONLY place the resolved
   * route colours live. `routeColor()` in TypeScript is the single source of
   * truth for them; nothing here ever recomputes a colour from the feed.
   */
  fun build(
    context: Context,
    journey: ActiveJourneyRecord,
    state: JourneyStateRecord,
    rail: RailRecord,
    copy: JourneySurfaceCopyRecord,
  ): Notification {
    val segment = rail.segments.firstOrNull { it.legIndex == state.legIndex }
    val glyph = vehicleDrawable(state, segment)

    val builder = NotificationCompat.Builder(context, ONGOING_CHANNEL_ID)
      .setSmallIcon(glyph)
      .setContentTitle(copy.hero)
      // The rider's own words for where they are going, on the phases whose
      // copy has no supporting line -- better than an empty second row.
      .setContentText(
        listOfNotNull(
          copy.supporting?.takeIf { it.isNotBlank() } ?: journey.destinationLabel,
          copy.liveLabel.takeIf { it.isNotBlank() },
        ).joinToString(" · "),
      )
      .setColor(parseColor(copy.accent.takeIf { it.isNotBlank() } ?: segment?.color))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(openApp(context))
      // Not an attempt to survive the swipe -- nothing short of pretending to
      // be a media session does that from Android 13 on. It is how the module
      // FINDS OUT about it, so `update` can stop redrawing a rail the rider
      // put away without also dropping the journey underneath it.
      .setDeleteIntent(JourneyDismissReceiver.deleteIntent(context))

    // THE ARCHITECTURE, IN THREE CALLS.
    //
    // `setWhen` + chronometer countdown is Android's twin of iOS's
    // `Text(timerInterval:)`: the system ticks it in the chip and in the shade
    // with no process of ours running and no push. A pre-formatted "4 min"
    // would be right for one second and frozen and wrong for the rest of the
    // wait, which is the exact failure this whole design exists to avoid --
    // and it is why a 40-minute journey costs ~8 updates instead of 2,400.
    //
    // So: never a countdown string here. Only a deadline the OS animates.
    val countdown = countdownTarget(state)
    if (countdown != null) {
      builder
        .setWhen(countdown)
        .setShowWhen(true)
        .setUsesChronometer(true)
        .setChronometerCountDown(true)
    } else {
      builder.setShowWhen(false)
    }

    // Only the builder call is conditional; everything either side of it is
    // the same notification. Below Android 16 the rider loses the chip and the
    // per-leg colours and keeps an ongoing notification with a progress bar.
    if (Build.VERSION.SDK_INT >= LIVE_UPDATE_SDK) {
      builder
        .setRequestPromotedOngoing(true)
        .setShortCriticalText(chipText(state, copy))
        .setStyle(progressStyle(context, state, rail, glyph))
    } else {
      val lengths = segmentLengths(rail)
      builder.setProgress(lengths.sum(), elapsedSeconds(state, lengths), false)
    }

    if (state.phase == PHASE_ALIGHT_SOON) {
      builder.addAction(acknowledgeAction(context))
    }

    return builder.build()
  }

  /**
   * The loud one. Its copy arrives already resolved through react-i18next --
   * the only prose on this side of the bridge that does, because it is the one
   * string a rider reads at the moment it matters.
   */
  fun buildAlert(context: Context, alert: LiveSurfaceAlertRecord): Notification =
    NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_live_journey_walk)
      .setContentTitle(alert.title)
      .setContentText(alert.body)
      .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setSilent(!alert.sound)
      .setContentIntent(openApp(context))
      .addAction(acknowledgeAction(context))
      .build()

  /**
   * The channel's vibration only plays when the channel is the one alerting,
   * and only as loudly as the rider's settings left it. The foreground service
   * is alive by construction whenever this fires, so the haptic is driven
   * directly instead -- the get-off alarm is the feature everything else is
   * scaffolding for, and it does not get to depend on a channel setting.
   */
  @Suppress("DEPRECATION")
  fun vibrate(context: Context) {
    val vibrator = vibrator(context) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator.vibrate(VibrationEffect.createWaveform(ALERT_VIBRATION_PATTERN, -1))
    } else {
      vibrator.vibrate(ALERT_VIBRATION_PATTERN, -1)
    }
  }

  fun stopVibrating(context: Context) {
    vibrator(context)?.cancel()
  }

  private fun vibrator(context: Context): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      context.getSystemService(Vibrator::class.java)
    }

  private fun progressStyle(
    context: Context,
    state: JourneyStateRecord,
    rail: RailRecord,
    glyph: Int,
  ): NotificationCompat.ProgressStyle {
    val lengths = segmentLengths(rail)
    val total = lengths.sum()

    val style = NotificationCompat.ProgressStyle()
      .setProgressSegments(
        rail.segments.mapIndexed { index, segment ->
          NotificationCompat.ProgressStyle.Segment(lengths[index])
            .setColor(parseColor(segment.color))
        },
      )
      .setProgressPoints(
        rail.points.map { point ->
          NotificationCompat.ProgressStyle.Point(
            point.atSeconds.roundToInt().coerceIn(0, total),
          )
        },
      )
      .setProgress(elapsedSeconds(state, lengths))
      .setProgressTrackerIcon(IconCompat.createWithResource(context, glyph))

    // Styling BY progress recolours the whole bar according to how far along
    // it is, which would throw away the per-leg route colours -- and those are
    // the point: they are the same colours as the map polylines and the
    // StepRail, so one journey is recognisably one journey across all three.
    style.setStyledByProgress(false)
    return style
  }

  /** Lengths in whole seconds, never zero: a zero-length segment would be a
   *  leg the rail silently forgot to draw. */
  private fun segmentLengths(rail: RailRecord): List<Int> =
    rail.segments.map { max(1, it.seconds.roundToInt()) }

  private fun elapsedSeconds(state: JourneyStateRecord, lengths: List<Int>): Int {
    val total = lengths.sum()
    return (state.progress.coerceIn(0.0, 1.0) * total).roundToInt().coerceIn(0, total)
  }

  /**
   * The deadline the OS should tick down to, or null when the hero is a count
   * rather than a clock.
   *
   * Riding falls back to the clock exactly when the stops cannot be counted,
   * which is the honesty rule: a number the app cannot stand behind is never
   * shown, but a self-ticking one it can always is.
   */
  private fun countdownTarget(state: JourneyStateRecord): Long? {
    val to = parseIso(state.timer?.to) ?: return null
    if (state.timer?.countsDown != true) return null
    return when (state.phase) {
      PHASE_WALKING_TO_STOP, PHASE_WAITING, PHASE_TRANSFERRING, PHASE_ARRIVING -> to
      PHASE_RIDING -> if (state.stopsRemaining == null) to else null
      else -> null
    }
  }

  /**
   * The status-bar chip. Null whenever a chronometer is running, because the
   * chip shows one thing and the countdown is the better one -- the spec's
   * "one number, never two", in the 96dp Android gives it.
   *
   * The hero rather than a short native string of its own. A chip vocabulary
   * kept over here is exactly the drift this module was carrying, and a hero
   * Android ellipsises still opens with the words that matter ("4 stops",
   * "Get off...") in whichever language the rider reads.
   */
  private fun chipText(state: JourneyStateRecord, copy: JourneySurfaceCopyRecord): String? =
    when (state.phase) {
      PHASE_ALIGHT_SOON, PHASE_ARRIVED, PHASE_OFF_PLAN -> copy.hero
      // A stop count is a chip; the clock the copy falls back to when no
      // position places the rider is already ticking beside it.
      PHASE_RIDING -> copy.hero.takeIf { state.stopsRemaining != null }
      else -> null
    }

  /** Grouped exactly as `VehicleIcon` (src/components/vehicle-icon.tsx) groups
   *  GTFS `route_type`, so the glyph on the lock screen is the glyph on the
   *  trip screen. */
  private fun vehicleDrawable(state: JourneyStateRecord, segment: RailSegmentRecord?): Int {
    if (segment?.kind == "walk" || state.leg == null) return R.drawable.ic_live_journey_walk
    return when (state.leg?.route?.type ?: 3) {
      0, 1, 2, 5, 7, 12, 100, 400, 900, 1400 -> R.drawable.ic_live_journey_rail
      4, 1000 -> R.drawable.ic_live_journey_ferry
      8, 1500 -> R.drawable.ic_live_journey_car
      else -> R.drawable.ic_live_journey_bus
    }
  }

  private fun acknowledgeAction(context: Context): NotificationCompat.Action =
    NotificationCompat.Action.Builder(
      R.drawable.ic_live_journey_walk,
      context.getString(R.string.live_journey_got_it),
      JourneyService.acknowledgeIntent(context),
    ).build()

  /** Tapping the notification lands in the app, which cold-launches straight
   *  into the journey screen when one is running. */
  private fun openApp(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      ?: return null
    return PendingIntent.getActivity(
      context,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun parseColor(hex: String?): Int =
    runCatching { Color.parseColor(hex ?: FALLBACK_COLOR) }
      .getOrElse { Color.parseColor(FALLBACK_COLOR) }

  /**
   * `Date.toISOString()` always writes milliseconds; the transit API's own
   * timestamps do not always. Parsed by hand rather than through a formatter
   * so both shapes work on every supported API level -- `java.time` is only
   * unconditionally available from 26, and this module supports 24.
   */
  private fun parseIso(iso: String?): Long? {
    if (iso.isNullOrEmpty()) return null
    return runCatching {
      val normalised = if (iso.contains('.')) iso else iso.replace(Regex("(Z|[+-]\\d{2}:?\\d{2})$"), ".000$1")
      val format = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", java.util.Locale.US)
      format.parse(normalised)?.time
    }.getOrNull()
  }
}
