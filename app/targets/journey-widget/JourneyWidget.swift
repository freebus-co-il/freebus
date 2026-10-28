import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct JourneyWidgetBundle: WidgetBundle {
  var body: some Widget {
    JourneyLiveActivity()
  }
}

struct JourneyLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: JourneyAttributes.self) { context in
      // The Lock Screen, StandBy and the Watch Smart Stack all render this one
      // view. They are free (no extra target, no extra code), which is most
      // of why the expanded layout is the layout.
      JourneyCard(attributes: context.attributes, state: context.state)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .environment(\.layoutDirection, context.state.direction)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          RouteBadge(state: context.state, compact: false)
            .padding(.leading, 4)
            .environment(\.layoutDirection, context.state.direction)
        }
        DynamicIslandExpandedRegion(.trailing) {
          HeroNumber(state: context.state, size: 24)
            .padding(.trailing, 4)
            .environment(\.layoutDirection, context.state.direction)
        }
        DynamicIslandExpandedRegion(.center) {
          Headline(attributes: context.attributes, state: context.state, compact: true)
            .environment(\.layoutDirection, context.state.direction)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Detail(state: context.state)
            .padding(.top, 4)
            .environment(\.layoutDirection, context.state.direction)
        }
      } compactLeading: {
        CompactSlot(state: context.state, region: .leading)
      } compactTrailing: {
        CompactSlot(state: context.state, region: .trailing)
      } minimal: {
        // Sharing the Island with another activity: the badge alone. Nothing
        // else survives that width, and the number IS the identity.
        RouteBadge(state: context.state, compact: true)
          .environment(\.layoutDirection, .leftToRight)
      }
      .keylineTint(Color(journeyHex: context.state.routeColorHex))
    }
  }
}

extension JourneyAttributes.ContentState {
  /// The app's reading direction. An activity from an older build carries
  /// none and keeps the left-to-right it always had.
  var direction: LayoutDirection {
    rtl == true ? .rightToLeft : .leftToRight
  }
}

// MARK: - Identity

/// The line, in its operator's colour. A rail route has no number to print --
/// every one of this feed's is blank -- so it falls back to a vehicle glyph
/// rather than an empty coloured pill, exactly as `VehicleIcon` does in-app.
private struct RouteBadge: View {
  let state: JourneyAttributes.ContentState
  let compact: Bool

  private var color: Color { Color(journeyHex: state.routeColorHex) }

  var body: some View {
    if state.journeyPhase.isOnFoot {
      Image(systemName: "figure.walk")
        .font(.system(size: compact ? 14 : 15, weight: .bold))
        .foregroundStyle(color)
    } else if state.alerting && compact {
      // Beside the camera the badge is all there is, so it says "get off".
      // On the card the line keeps its badge: the hero already says it.
      Image(systemName: "figure.walk.departure")
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
    } else if state.routeShortName.isEmpty {
      Image(systemName: state.vehicleSymbol)
        .font(.system(size: compact ? 13 : 14, weight: .bold))
        .foregroundStyle(color)
    } else if compact {
      // No pill in the compact presentations: filling a 24pt slot with colour
      // leaves the number too small to read at arm's length, which is the only
      // distance this presentation is ever read from.
      Text(state.routeShortName)
        .font(.system(size: 15, weight: .heavy, design: .rounded))
        .foregroundStyle(color)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    } else {
      Text(state.routeShortName)
        .font(.system(size: 15, weight: .heavy, design: .rounded))
        .foregroundStyle(journeyReadableTextIsBlack(onHex: state.routeColorHex) ? .black : .white)
        .lineLimit(1)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
  }
}

// MARK: - The compact pair

/// The badge and the number, pinned to one physical order whatever language
/// the phone is in.
///
/// iOS mirrors `compactLeading`/`compactTrailing` under an RTL language, so on
/// a Hebrew phone the badge sat to the RIGHT of the camera and the clock to
/// its left. Nothing in this pair is language -- a route number, a vehicle
/// glyph, a self-ticking clock -- so the mirror bought no legibility, and it
/// cost the layout: `.trailing` inside the clock's fixed-width box flips with
/// everything else, which pushed the digits hard against the outer edge of the
/// Island instead of holding them off it.
///
/// So each region asks which side of the camera it is PHYSICALLY on and fills
/// itself accordingly, then pins its own contents to `leftToRight` so every
/// alignment inside behaves exactly as it does in English. The expanded and
/// Lock Screen layouts deliberately keep mirroring -- those carry the rider's
/// own Hebrew, and belong the way their language reads.
private struct CompactSlot: View {
  enum Region { case leading, trailing }

  let state: JourneyAttributes.ContentState
  let region: Region
  @Environment(\.layoutDirection) private var direction

  /// True where this region lands on the camera's left, which is what the
  /// leading region means in English and what the trailing one means in Hebrew.
  private var isCameraLeft: Bool {
    (region == .leading) == (direction == .leftToRight)
  }

  var body: some View {
    Group {
      if isCameraLeft {
        RouteBadge(state: state, compact: true)
      } else {
        CompactTrailing(state: state)
      }
    }
    .environment(\.layoutDirection, .leftToRight)
  }
}

// MARK: - The one number

/// ONE number, never two, and never a number this side invented.
///
/// Each branch is either a self-ticking primitive or a count GPS actually
/// established. Nothing here formats a duration into a string: a string would
/// be right for one second and then frozen for the rest of the ride.
private struct CompactTrailing: View {
  let state: JourneyAttributes.ContentState

  private var tint: Color {
    // Stage ① of the escalation: two stops out, the trailing element takes the
    // alert colour and NOTHING makes a sound. It is for the rider who happens
    // to glance, and turning it into an interruption would spend the alert
    // budget three minutes before the moment it is for.
    state.nudging || state.alerting ? Color(journeyHex: journeyAlertColorHex) : .white
  }

  var body: some View {
    switch state.journeyPhase {
    case .alightSoon:
      // The word arrives translated, like every other word here. An activity
      // started by an older build carries none -- a glyph then, never the
      // English that used to be hardcoded on this line.
      if let now = state.alightNow, !now.isEmpty {
        Text(now)
          .font(.system(size: 14, weight: .heavy, design: .rounded))
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
      } else {
        Image(systemName: "figure.walk.departure")
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
      }
    case .arrived:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(.green)
    case .offPlan:
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
    case .riding:
      if let stops = state.stopsRemaining {
        // Stops left, the number a rider counts down through the window.
        Text("\(stops)")
          .font(.system(size: 16, weight: .heavy, design: .rounded))
          .foregroundStyle(tint)
      } else if let range = state.rideRange ?? state.timerRange {
        // No position: a ring rather than a count the app cannot stand
        // behind. It fills by the timetable, on its own.
        ProgressView(timerInterval: range, countsDown: false) {
          EmptyView()
        } currentValueLabel: {
          EmptyView()
        }
        .progressViewStyle(.circular)
        .tint(tint)
      }
    default:
      if let range = state.timerRange {
        Text(timerInterval: range, countsDown: true)
          .font(.system(size: 15, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .frame(width: 46)
          .foregroundStyle(tint)
      }
    }
  }
}

/// The big number at the card's end: a countdown with what it counts to over
/// it, or the stops left with the word under it.
///
/// Only ever a self-ticking timer or a count GPS established, which is what
/// keeps it right between updates. Nothing here formats a duration into a
/// string: a string would be right for one second and frozen after.
private struct HeroNumber: View {
  let state: JourneyAttributes.ContentState
  var size: CGFloat = 30

  private var alert: Color { Color(journeyHex: journeyAlertColorHex) }

  var body: some View {
    switch state.journeyPhase {
    case .alightSoon:
      if state.alerting {
        // "Got it", where the number was: the one thing to do at this moment,
        // without unlocking the phone.
        Button(intent: AcknowledgeAlightIntent()) {
          Image(systemName: "checkmark")
            .font(.system(size: size * 0.6, weight: .black))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
        }
        .buttonStyle(.bordered)
        .tint(alert)
        .accessibilityLabel(Text(AcknowledgeAlightIntent.title))
      } else {
        Image(systemName: "figure.walk.departure")
          .font(.system(size: size * 0.85, weight: .bold))
          .foregroundStyle(alert)
      }
    case .arrived:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: size * 0.85, weight: .bold))
        .foregroundStyle(.green)
    case .offPlan:
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: size * 0.85, weight: .bold))
        .foregroundStyle(alert)
    case .riding:
      if let stops = state.stopsRemaining {
        // Stops, not an ETA. A rider can count these off through the window,
        // which is the whole reason the trip screen leads with them too.
        VStack(alignment: .trailing, spacing: -3) {
          Text("\(stops)")
            .font(.system(size: size + 4, weight: .heavy, design: .rounded))
            .foregroundStyle(state.nudging ? alert : .primary)
            .contentTransition(.numericText(countsDown: true))
          if let label = state.rideStopsLabel {
            Text(label)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      } else {
        countdown
      }
    default:
      countdown
    }
  }

  @ViewBuilder private var countdown: some View {
    if let range = state.timerRange {
      VStack(alignment: .trailing, spacing: 0) {
        if let label = state.countdownLabel {
          Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        // `Text(timerInterval:)` sizes itself for the widest value it could
        // ever show, so it is given a fixed box and one line: left to wrap, a
        // Hebrew card broke "58:12" across two lines.
        Text(timerInterval: range, countsDown: true)
          .font(.system(size: size, weight: .heavy, design: .rounded))
          .monospacedDigit()
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .multilineTextAlignment(.trailing)
          .frame(width: size * 2.9, alignment: .trailing)
          .environment(\.layoutDirection, .leftToRight)
        if let live = state.liveLabel {
          LiveLabel(text: live, isLive: state.isLive == true)
        }
      }
    }
  }
}

/// "Live" with a green dot, or "Scheduled" plain: whether the countdown
/// above it is a prediction or a promise from the timetable.
private struct LiveLabel: View {
  let text: String
  let isLive: Bool

  var body: some View {
    HStack(spacing: 3) {
      if isLive {
        Circle()
          .fill(.green)
          .frame(width: 5, height: 5)
      }
      // Hebrew's "לפי לוח זמנים" is longer than "Scheduled": scaled rather
      // than wrapped, so the column keeps its shape.
      Text(text)
        .font(.caption2)
        .foregroundStyle(isLive ? .green : .secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }
  }
}

// MARK: - The words

/// The hero and the line under it. Waiting, the hero is the direction (the
/// badge already says the line); riding, it is the stop to get off at, with
/// the next stop under it.
private struct Headline: View {
  let attributes: JourneyAttributes
  let state: JourneyAttributes.ContentState
  var compact = false

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(state.hero)
        .font(compact ? .subheadline.weight(.semibold) : .headline)
        .foregroundStyle(state.alerting ? Color(journeyHex: journeyAlertColorHex) : .primary)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
      // The destination label is the rider's own words for where they are
      // going, so it stands in on the phases whose copy has no second line.
      Text(state.supporting ?? attributes.destinationLabel)
        .font(compact ? .caption : .subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Under the headline: the stop strip on a ride, or the later rides at a stop.
/// The get-off alert needs no row of its own: the hero already says it, and
/// its "Got it" sits where the number was (see `HeroNumber`).
private struct Detail: View {
  let state: JourneyAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let stops = state.rideStops {
        StopStrip(state: state, stops: stops)
      } else if let then = state.then {
        Text(then)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

// MARK: - The stop strip

/// The ride as the rider sees it through the window: one dot per stop, the
/// ones behind them filled in the line's colour, the vehicle where they are,
/// and the stop to get off at drawn bigger at the end.
///
/// With no fix the dots stay hollow and the line fills by the timetable,
/// which the OS animates with no process running. It is the same honesty rule
/// as the big number: a position the app does not have is never drawn as if
/// it did.
private struct StopStrip: View {
  let state: JourneyAttributes.ContentState
  let stops: Int
  @Environment(\.layoutDirection) private var direction

  /// Past this many the dots would touch; the strip then draws only the ends,
  /// and the line between them still says how far along the ride is.
  private let maxDots = 24
  private let track: CGFloat = 4
  private let endDot: CGFloat = 12

  private var color: Color { Color(journeyHex: state.routeColorHex) }
  private var alert: Color { Color(journeyHex: journeyAlertColorHex) }

  var body: some View {
    GeometryReader { geometry in
      let inset = endDot / 2
      let span = max(geometry.size.width - endDot, 1)
      let x = { (index: Int) -> CGFloat in inset + span * CGFloat(index) / CGFloat(max(stops, 1)) }

      ZStack(alignment: .leading) {
        Capsule()
          .fill(.secondary.opacity(0.35))
          .frame(width: span, height: track)
          .offset(x: inset)

        if let passed = state.ridePassed {
          Capsule()
            .fill(color)
            .frame(width: max(x(passed) - inset, track), height: track)
            .offset(x: inset)
        } else if let range = state.rideRange {
          ProgressView(timerInterval: range, countsDown: false) {
            EmptyView()
          } currentValueLabel: {
            EmptyView()
          }
          .progressViewStyle(.linear)
          .tint(color)
          .frame(width: span)
          .offset(x: inset)
        }

        if stops <= maxDots {
          ForEach(1..<stops, id: \.self) { index in
            Circle()
              .fill(isPassed(index) ? color : Color.secondary.opacity(0.6))
              .frame(width: 6, height: 6)
              .offset(x: x(index) - 3)
          }
        }

        // The stop boarded at.
        Circle()
          .fill(state.ridePassed == nil ? Color.secondary : color)
          .frame(width: 8, height: 8)
          .offset(x: x(0) - 4)

        // The stop to get off at: the one the whole strip is about.
        Circle()
          .strokeBorder(state.nudging || state.alerting ? alert : Color.primary, lineWidth: 3)
          .background(Circle().fill(.black))
          .frame(width: endDot, height: endDot)
          .offset(x: x(stops) - endDot / 2)

        if let passed = state.ridePassed {
          Image(systemName: state.vehicleSymbol)
            .font(.system(size: 9, weight: .black))
            .foregroundStyle(.black)
            .frame(width: 18, height: 18)
            .background(.white, in: Circle())
            .offset(x: x(passed) - 9)
        }
      }
      .frame(width: geometry.size.width, height: 18)
    }
    .frame(height: 18)
    // Drawn in left-to-right coordinates and mirrored whole for Hebrew, so a
    // ride runs from the start of the line to its end in either language.
    .environment(\.layoutDirection, .leftToRight)
    .scaleEffect(x: direction == .rightToLeft ? -1 : 1, y: 1)
  }

  private func isPassed(_ index: Int) -> Bool {
    guard let passed = state.ridePassed else { return false }
    return index <= passed
  }
}

// MARK: - Lock Screen / StandBy

private struct JourneyCard: View {
  let attributes: JourneyAttributes
  let state: JourneyAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        RouteBadge(state: state, compact: false)
        Headline(attributes: attributes, state: state)
        HeroNumber(state: state)
      }
      Detail(state: state)
    }
  }
}

// MARK: - Colour

extension Color {
  /// The `#rrggbb` a route arrives coloured in. Parsed rather than looked up:
  /// the resolved colour crosses the bridge already, so this target never
  /// learns which operator runs which line, and cannot drift from the map.
  init(journeyHex hex: String) {
    let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    let full = cleaned.count == 3 ? cleaned.map { "\($0)\($0)" }.joined() : cleaned
    let value = Int(full.prefix(6), radix: 16) ?? 0x66_66_66
    self.init(
      .sRGB,
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }
}
