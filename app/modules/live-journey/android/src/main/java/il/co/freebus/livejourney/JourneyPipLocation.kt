package il.co.freebus.livejourney

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * The rider's position while the journey is the PiP window.
 *
 * expo-location stops every watch when the activity pauses
 * (`OnActivityEntersBackground`), and a PiP activity is paused while visible --
 * so the foreground watch the journey relies on goes silent in exactly the
 * window that counts stops. This asks the fused provider directly, for as long
 * as PiP lasts and no longer; outside PiP the expo-location watch owns the
 * position as before.
 *
 * Covered, to the OS and to the rider, by the location-typed `JourneyService`
 * and its notification, which run for the whole journey.
 */
object JourneyPipLocation {
  private const val TAG = "JourneyPipLocation"

  /** The same bargain as the in-app watch: the machine only counts stops with
   *  a fix, and a rider standing still has nothing new to say. */
  private const val INTERVAL_MS = 5_000L
  private const val MIN_DISTANCE_METERS = 20f

  private var client: FusedLocationProviderClient? = null
  private var callback: LocationCallback? = null

  fun start(context: Context, onFix: (Location) -> Unit) {
    if (callback != null) return
    // Never asks: permission is the app's to request, in the app. Without it
    // nothing is emitted and the machine falls back exactly as with no fix.
    val granted = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
      .any { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    if (!granted) return

    val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
      .setMinUpdateDistanceMeters(MIN_DISTANCE_METERS)
      .build()
    val next = object : LocationCallback() {
      override fun onLocationResult(result: LocationResult) {
        result.lastLocation?.let(onFix)
      }
    }
    val provider = LocationServices.getFusedLocationProviderClient(context.applicationContext)
    try {
      provider.requestLocationUpdates(request, next, Looper.getMainLooper())
      client = provider
      callback = next
    } catch (error: SecurityException) {
      Log.w(TAG, "Location permission withdrawn between the check and the request", error)
    }
  }

  fun stop() {
    val current = callback ?: return
    client?.removeLocationUpdates(current)
    callback = null
    client = null
  }
}
