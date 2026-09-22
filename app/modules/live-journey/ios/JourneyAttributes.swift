import ActivityKit
import AppIntents
import Foundation

// ============================================================================
// THIS FILE EXISTS TWICE, BYTE FOR BYTE:
//
//   modules/live-journey/ios/JourneyAttributes.swift   (the app, via the pod)
//   targets/journey-widget/JourneyAttributes.swift     (the widget extension)
//
// Apple's own Live Activity samples share one file by giving it membership in
// both targets. There is no target-membership checkbox here: the module is a
// CocoaPod and the widget is a synchronised folder, two Swift modules that
// cannot import each other. ActivityKit matches an activity to its widget by
// the UNQUALIFIED type name, so two identical declarations in two modules are
// the same activity as far as the system is concerned -- which is exactly what
// the dual-membership trick relies on too.
//
// Edit one, copy it over the other. They must not drift.
// ============================================================================

/// Mirror of `JourneyPhase` in `src/features/journey/types.ts`. The raw values
/// are the wire format and must match that union exactly.
enum JourneyPhase: String {
  case walkingToStop = "walking-to-stop"
  case waiting
  case riding
  case alightSoon = "alight-soon"
  case transferring
  case arriving
  case arrived
  case offPlan = "off-plan"

  /// Phases where the rider is on foot, and so has no line to be identified by.
  var isOnFoot: Bool {
    self == .walkingToStop || self == .transferring || self == .arriving
  }
}

/// The colour the surface shouts in. The Dynamic Island is always dark, so this
/// is the app's DARK-scheme `danger` from `src/constants/theme.ts` rather than
/// the light one, which would disappear against it.
let journeyAlertColorHex = "#FF6B60"

/// The rider is close enough to their stop that a glance should already be
/// uneasy. Stage ① of the spec's escalation: the trailing element takes the
/// alert colour and NOTHING else happens -- no sound, no haptic, no expansion.
let silentNudgeStopsRemaining = 2

/// The SF Symbol for a GTFS `route_type`, grouped exactly as `VehicleIcon` in
/// `src/components/vehicle-icon.tsx` groups them, so the badge on the Lock
/// Screen is the badge on the trip screen.
func journeyVehicleSymbol(routeType: Int) -> String {
  let rail: Set<Int> = [0, 1, 2, 5, 7, 12, 100, 400, 900, 1400]
  let ferry: Set<Int> = [4, 1000]
  let taxi: Set<Int> = [8, 1500]
  if rail.contains(routeType) { return "tram.fill" }
  if ferry.contains(routeType) { return "ferry.fill" }
  if taxi.contains(routeType) { return "car.fill" }
  return "bus.fill"
}

/// Black or white text over a `#`-prefixed hex, by the same perceived-luminance
/// rule as `readableTextColor` in `src/lib/route-color.ts`. Duplicated rather
/// than passed across the bridge because the route colour itself is passed, and
/// a badge whose text colour disagreed with the app's would be worse than the
/// six lines of arithmetic.
func journeyReadableTextIsBlack(onHex hex: String) -> Bool {
  let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
  let full = cleaned.count == 3 ? cleaned.map { "\($0)\($0)" }.joined() : cleaned
  guard full.count >= 6, let value = Int(full.prefix(6), radix: 16) else { return false }
  let r = Double((value >> 16) & 0xFF)
  let g = Double((value >> 8) & 0xFF)
  let b = Double(value & 0xFF)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
}

@available(iOS 16.2, *)
struct JourneyAttributes: ActivityAttributes {
  /// One leg, as a length and a colour. The mirror of `RailSegment` in
  /// `src/features/journey/journey-rail.ts` -- the colour arrives already
  /// resolved by `routeColor()`, so nothing here ever has to know that the
  /// feed's own `route_color` exists.
  struct Segment: Codable, Hashable {
    var seconds: Double
    var colorHex: String
    var isWalk: Bool
  }

  /// Everything that changes while the journey runs.
  ///
  /// `timerFrom`/`timerTo` are `Date`s and NOT a formatted countdown, and that
  /// is the single most load-bearing decision in this file.
  /// `Text(timerInterval:)` and `ProgressView(timerInterval:)` are the only
  /// things iOS interpolates frame to frame with no process running; every
  /// other field here is a still frame until the next `update()`. A
  /// pre-formatted "4 min" would be correct for one second and then frozen and
  /// wrong for the rest of the ride, which is the exact failure the whole
  /// architecture is built to avoid.
  struct ContentState: Codable, Hashable {
    var phase: String
    /// The two lines the surface prints, resolved through `react-i18next` in
    /// `journey-copy.ts` and carried here verbatim.
    ///
    /// This target owns NO translated prose of its own, and that is the point:
    /// the alternative is a second copy of the `journey.*` keys living over
    /// here, one per locale, free to drift from the JSON every other surface
    /// reads. Hebrew is a first-class locale, so that drift would be visible.
    var hero: String
    var supporting: String?
    /// "Get off" in one word, for the Island's compact trailing slot -- which
    /// is about 46pt wide and cannot hold the `alight-soon` hero. Optional
    /// only for the activity a previous build already has running: nothing
    /// this app version starts omits it. See `CompactTrailing`, which falls
    /// back to a glyph rather than to an English word.
    var alightNow: String?
    /// "Live" / "Scheduled" beside a departure countdown. Optional for the
    /// activity a previous build already has running.
    var liveLabel: String?
    var routeShortName: String
    var routeColorHex: String
    var routeType: Int
    var stopsRemaining: Int?
    var progress: Double
    var timerFrom: Date?
    var timerTo: Date?
    /// The get-off alert's copy. Separate from `hero` because it is the copy
    /// that ARRIVED with an alert -- the widget uses its presence to decide
    /// whether to draw the acknowledge button.
    var alertTitle: String?
    var alertBody: String?
    /// Set by the "Got it" App Intent, in the app's process, without the phone
    /// ever being unlocked.
    var acknowledged: Bool

    var journeyPhase: JourneyPhase {
      JourneyPhase(rawValue: phase) ?? .riding
    }

    /// The range for the self-ticking primitives, or nil.
    ///
    /// `Text(timerInterval:)` takes a `ClosedRange`, and building one whose
    /// bounds are out of order traps. A journey whose deadline has already
    /// passed is entirely ordinary -- a late bus does it every day -- so the
    /// range is the thing that has to be optional, and the views fall back to
    /// something static.
    var timerRange: ClosedRange<Date>? {
      guard let from = timerFrom, let to = timerTo, to > from else { return nil }
      return from...to
    }

    /// Stage ① of the escalation. Read by the compact trailing element to
    /// change colour and by nothing that makes a sound.
    var nudging: Bool {
      guard !acknowledged, let stops = stopsRemaining else { return false }
      return stops <= silentNudgeStopsRemaining
    }

    var alerting: Bool {
      journeyPhase == .alightSoon && !acknowledged
    }

    var vehicleSymbol: String {
      journeyVehicleSymbol(routeType: routeType)
    }
  }

  var journeyId: String
  var destinationLabel: String
  var totalSeconds: Double
  var segments: [Segment]
  /// `RailPoint.atSeconds` -- the moments the rider changes vehicle, drawn as
  /// diamonds on the rail.
  var pointSeconds: [Double]
}

extension Notification.Name {
  /// Posted in the app's process when the rider acknowledges the get-off alert.
  /// `LiveJourneyModule` forwards it to JS; the activity is already updated by
  /// the time it does, so the surface responds even if JS is not running.
  static let liveJourneyAcknowledgeAlight = Notification.Name("il.co.freebus.livejourney.acknowledgeAlight")
}

/// "Got it", as a button the rider can press on the Lock Screen.
///
/// A `LiveActivityIntent` is performed by the APP, which iOS launches in the
/// background to run it -- so acknowledging never costs the rider a Face ID
/// prompt at the moment they are least able to give one. It writes the new
/// content state itself rather than waiting for JS to come back, because the
/// app may well have been suspended and there is nothing to come back.
@available(iOS 17.0, *)
struct AcknowledgeAlightIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Got it"
  static var isDiscoverable: Bool = false

  func perform() async throws -> some IntentResult {
    for activity in Activity<JourneyAttributes>.activities {
      var state = activity.content.state
      state.acknowledged = true
      state.alertTitle = nil
      state.alertBody = nil
      await activity.update(ActivityContent(state: state, staleDate: nil))
    }
    NotificationCenter.default.post(name: .liveJourneyAcknowledgeAlight, object: nil)
    return .result()
  }
}
