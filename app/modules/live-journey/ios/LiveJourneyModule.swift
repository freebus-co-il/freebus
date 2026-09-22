import ActivityKit
import ExpoModulesCore

// The records below mirror the TypeScript types they are converted from. They
// deliberately declare only the fields the surfaces draw: an Expo `Record`
// ignores keys it was not asked for, so the whole `Itinerary` can cross the
// bridge inside `ActiveJourney` and cost nothing on this side.

/// A subset of `ActiveJourney` (`src/features/journey/types.ts`).
struct ActiveJourneyRecord: Record {
  @Field var id: String = ""
  @Field var destinationLabel: String = ""
}

struct RouteRecord: Record {
  @Field var shortName: String = ""
  /// GTFS `route_type`, for the vehicle glyph a rail line needs because it has
  /// no number to print.
  @Field var type: Int = 3
}

/// A subset of `TransitLeg` (`src/api/types.ts`).
///
/// The stop names and arrival times this used to carry are gone: the surface
/// prints `JourneySurfaceCopy`, and composing "<stop> · <time>" here was a
/// wordless reimplementation of the `journey.offAt` key. All that is left is
/// the leg's IDENTITY, which is a badge and a glyph rather than a sentence.
struct TransitLegRecord: Record {
  @Field var route: RouteRecord?
}

/// `JourneyState['timer']`. ISO-8601 strings, parsed to `Date`s here -- the
/// widget needs real dates for `Text(timerInterval:)` to tick itself.
struct TimerRecord: Record {
  @Field var from: String = ""
  @Field var to: String = ""
  @Field var countsDown: Bool = true
}

/// `JourneyState`.
struct JourneyStateRecord: Record {
  @Field var phase: String = ""
  @Field var legIndex: Int = 0
  @Field var leg: TransitLegRecord?
  @Field var stopsRemaining: Int?
  @Field var timer: TimerRecord?
  @Field var offPlan: String?
  @Field var progress: Double = 0
}

/// `RailSegment`.
struct RailSegmentRecord: Record {
  @Field var legIndex: Int = 0
  @Field var seconds: Double = 0
  @Field var color: String = "#666666"
  @Field var kind: String = "transit"
}

/// `RailPoint`.
struct RailPointRecord: Record {
  @Field var atSeconds: Double = 0
}

/// `JourneyRail`.
struct RailRecord: Record {
  @Field var totalSeconds: Double = 0
  @Field var segments: [RailSegmentRecord] = []
  @Field var points: [RailPointRecord] = []
}

/// `JourneySurfaceCopy`. The two lines the surface prints, resolved through
/// `react-i18next` in `journey-copy.ts` -- which is how the widget speaks
/// Hebrew without owning a single translated string.
///
/// `accent` is declared because the JS contract carries it and an Expo
/// `Record` that omitted it would silently drop a field a later reader expects
/// to find. It is deliberately NOT drawn: it is resolved against the app's
/// light or dark palette, and the Dynamic Island is always dark, so a
/// light-mode accent would arrive here invisible. Colour on this side comes
/// from the rail, which is theme-independent and shared with the map.
struct JourneySurfaceCopyRecord: Record {
  @Field var hero: String = ""
  @Field var supporting: String?
  @Field var accent: String = ""
  /// "Get off", in one word, for the compact slot beside the camera. Resolved
  /// on the JS side like every other word this target prints.
  @Field var alightNow: String = ""
  /// "Live" / "Scheduled" beside a departure countdown, already translated.
  @Field var liveLabel: String = ""
}

/// `LiveSurfaceAlert`. `title` and `body` arrive already resolved through
/// `react-i18next`, which is how the widget shouts in Hebrew without knowing any.
struct LiveSurfaceAlertRecord: Record {
  @Field var title: String = ""
  @Field var body: String = ""
  @Field var sound: Bool = true
  @Field var vibrate: Bool = true
}

class LiveActivityUnavailableException: Exception {
  override var reason: String {
    "Live Activities are switched off for this app in Settings, or unsupported on this device"
  }
}

class NoActiveJourneyException: Exception {
  override var reason: String {
    "update() or stop() was called with no Live Activity running"
  }
}

public class LiveJourneyModule: Module {
  /// Typed as `Any?` because `Activity` is only available from iOS 16.1 and a
  /// stored property cannot carry an availability annotation.
  private var activityStorage: Any?
  /// The rail from `start`, kept because it is the ONLY place the resolved
  /// route colours live. `JourneyState` carries the leg but not its colour --
  /// colour is `routeColor(leg.route)`, an operator lookup this side must
  /// never re-implement -- so every `update` reads the colour for its
  /// `legIndex` back out of here.
  private var rail: RailRecord?
  private var acknowledgeObserver: NSObjectProtocol?

  @available(iOS 16.2, *)
  private var activity: Activity<JourneyAttributes>? {
    get { activityStorage as? Activity<JourneyAttributes> }
    set { activityStorage = newValue }
  }

  public func definition() -> ModuleDefinition {
    Name("LiveJourney")

    Events("onAcknowledgeAlight")

    OnCreate {
      // The "Got it" App Intent runs in this process and updates the activity
      // on its own; this only tells JS so the in-app surfaces agree. The order
      // matters: the Lock Screen is already right before JS hears anything,
      // which is what makes acknowledging work with the app suspended.
      self.acknowledgeObserver = NotificationCenter.default.addObserver(
        forName: .liveJourneyAcknowledgeAlight,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onAcknowledgeAlight", [:])
      }
    }

    OnDestroy {
      if let observer = self.acknowledgeObserver {
        NotificationCenter.default.removeObserver(observer)
      }
    }

    AsyncFunction("start") { (
      journey: ActiveJourneyRecord,
      state: JourneyStateRecord,
      rail: RailRecord,
      copy: JourneySurfaceCopyRecord
    ) in
      guard #available(iOS 16.2, *) else { return }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw LiveActivityUnavailableException()
      }

      // One journey at a time, per the spec. A start that finds a stale
      // activity ends it rather than leaving two lock-screen cards arguing.
      if let running = self.activity {
        await running.end(nil, dismissalPolicy: .immediate)
        self.activity = nil
      }

      self.rail = rail

      let attributes = JourneyAttributes(
        journeyId: journey.id,
        destinationLabel: journey.destinationLabel,
        totalSeconds: max(rail.totalSeconds, 1),
        segments: rail.segments.map {
          JourneyAttributes.Segment(seconds: $0.seconds, colorHex: $0.color, isWalk: $0.kind == "walk")
        },
        pointSeconds: rail.points.map(\.atSeconds)
      )

      self.activity = try Activity.request(
        attributes: attributes,
        content: ActivityContent(
          state: self.contentState(from: state, copy: copy, alert: nil, acknowledged: false),
          staleDate: nil
        ),
        pushType: nil
      )
    }

    AsyncFunction("update") { (
      state: JourneyStateRecord,
      copy: JourneySurfaceCopyRecord,
      alert: LiveSurfaceAlertRecord?
    ) in
      guard #available(iOS 16.2, *) else { return }
      guard let activity = self.activity else { throw NoActiveJourneyException() }

      // An alert is only ever sent for a leg the rider has NOT acknowledged --
      // `resolveJourneyState` stops reporting `alight-soon` once they have --
      // so an alert resets the flag and a plain redraw carries it forward.
      // Losing it here would put the alert styling back on a rider who already
      // said they were awake.
      let acknowledged = alert == nil ? activity.content.state.acknowledged : false
      let content = ActivityContent(
        state: self.contentState(from: state, copy: copy, alert: alert, acknowledged: acknowledged),
        staleDate: nil
      )

      // `alertConfiguration:` is the whole difference between a silent redraw
      // and an interruption: it is what expands the Island, fires the haptic,
      // and breaks through on the Lock Screen. It is therefore spent only on
      // the three moments in the spec's alert budget, which JS decides by
      // passing an alert at all.
      guard let alert, alert.sound || alert.vibrate else {
        await activity.update(content)
        return
      }

      // ActivityKit has no silent-but-interrupting alert -- a configuration
      // always plays the sound. A rider who turned sound off but kept vibrate
      // still gets the configuration, because the haptic and the expansion are
      // the point and they come with it or not at all.
      await activity.update(
        content,
        alertConfiguration: AlertConfiguration(
          title: LocalizedStringResource(stringLiteral: alert.title),
          body: LocalizedStringResource(stringLiteral: alert.body),
          sound: .default
        )
      )
    }

    AsyncFunction("stop") {
      guard #available(iOS 16.2, *) else { return }
      guard let activity = self.activity else { return }
      // `.immediate` rather than leaving the card up: the journey is over, and
      // a finished journey lingering on the Lock Screen is the app failing to
      // notice something the rider already knows.
      await activity.end(nil, dismissalPolicy: .immediate)
      self.activity = nil
      self.rail = nil
    }
  }

  /// ISO-8601 with and without fractional seconds. `Date.toISOString()` always
  /// writes the milliseconds; the API's own timestamps do not always, and
  /// `ISO8601DateFormatter` refuses a string that disagrees with its options.
  private static let isoFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static let isoPlain = ISO8601DateFormatter()

  private static func date(_ iso: String?) -> Date? {
    guard let iso, !iso.isEmpty else { return nil }
    return isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
  }

  @available(iOS 16.2, *)
  private func contentState(
    from state: JourneyStateRecord,
    copy: JourneySurfaceCopyRecord,
    alert: LiveSurfaceAlertRecord?,
    acknowledged: Bool
  ) -> JourneyAttributes.ContentState {
    let segment = rail?.segments.first { $0.legIndex == state.legIndex }

    return JourneyAttributes.ContentState(
      phase: state.phase,
      hero: copy.hero,
      supporting: copy.supporting?.isEmpty == false ? copy.supporting : nil,
      alightNow: copy.alightNow.isEmpty ? nil : copy.alightNow,
      liveLabel: copy.liveLabel.isEmpty ? nil : copy.liveLabel,
      routeShortName: state.leg?.route?.shortName ?? "",
      routeColorHex: segment?.color ?? "#666666",
      routeType: state.leg?.route?.type ?? 3,
      stopsRemaining: state.stopsRemaining,
      progress: min(max(state.progress, 0), 1),
      timerFrom: Self.date(state.timer?.from),
      timerTo: Self.date(state.timer?.to),
      alertTitle: alert?.title,
      alertBody: alert?.body,
      acknowledged: acknowledged
    )
  }
}
