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
      // view. They are free -- no extra target, no extra code -- which is most
      // of why the expanded layout is the layout.
      JourneyCard(attributes: context.attributes, state: context.state)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 7) {
            RouteBadge(state: context.state, compact: false)
            Text(context.state.hero)
              .font(.caption.weight(.semibold))
              .lineLimit(1)
              .minimumScaleFactor(0.8)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          HeroNumber(state: context.state)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 7) {
            RailBar(attributes: context.attributes, state: context.state)
            Footer(attributes: context.attributes, state: context.state)
          }
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
    } else if state.alerting {
      Image(systemName: "figure.walk.departure")
        .font(.system(size: compact ? 14 : 15, weight: .bold))
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
      if let range = state.timerRange {
        // A ring rather than a countdown while seated: an ETA in the seat is
        // trivia, and the ring says "some of the way through" without
        // pretending to a precision the schedule does not have.
        ProgressView(timerInterval: range, countsDown: false) {
          EmptyView()
        } currentValueLabel: {
          EmptyView()
        }
        .progressViewStyle(.circular)
        .tint(tint)
      } else if let stops = state.stopsRemaining {
        Text("\(stops)")
          .font(.system(size: 16, weight: .heavy, design: .rounded))
          .foregroundStyle(tint)
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

/// The expanded hero's NUMBER, given room. The words beside it are
/// `state.hero`; this is only ever a self-ticking timer or a count GPS
/// established, which is what keeps it right between updates.
///
/// Shared by the Lock Screen card and the Dynamic Island's EXPANDED trailing
/// region -- both tight slots, which is why nothing drawn here is allowed to
/// wrap onto a second line.
private struct HeroNumber: View {
  let state: JourneyAttributes.ContentState

  var body: some View {
    switch state.journeyPhase {
    case .alightSoon:
      Image(systemName: "figure.walk.departure")
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
    case .arrived:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(.green)
    case .offPlan:
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
    case .riding:
      if let stops = state.stopsRemaining {
        // Stops, not an ETA. A rider can count these off through the window,
        // which is the whole reason the trip screen leads with them too.
        VStack(alignment: .trailing, spacing: -2) {
          Text("\(stops)")
            .font(.system(size: 26, weight: .heavy, design: .rounded))
            .foregroundStyle(state.nudging ? Color(journeyHex: journeyAlertColorHex) : .primary)
          Image(systemName: "mappin.and.ellipse")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
        }
      } else if let range = state.timerRange {
        // No position, so no stop count -- the clock instead, never a count
        // invented from the timetable.
        countdown(range)
      }
    default:
      if let range = state.timerRange {
        countdown(range)
      }
    }
  }

  private func countdown(_ range: ClosedRange<Date>) -> some View {
    // The label sits beside the clock rather than replacing any of its
    // digits, so "Scheduled" reads as a caveat on the number rather than as
    // the number itself -- the honesty rule is about what the digits mean,
    // not about hiding them.
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(timerInterval: range, countsDown: true)
        .font(.system(size: 24, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .frame(width: 84)
      if let label = state.liveLabel {
        // Hebrew's "לפי לוח זמנים" is longer than "Scheduled" -- without a
        // guard it can wrap and break the baseline this HStack promises, or
        // push past the slot both host views give HeroNumber.
        Text(label)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
    }
  }
}

// MARK: - The rail

/// The journey as a bar: origin dot, coloured segments, a diamond wherever the
/// rider changes vehicle, a tracker riding it, destination flag.
///
/// The geometry is `buildJourneyRail`'s output and nothing else, which is what
/// stops the Lock Screen and the journey screen drawing two different pictures
/// of one journey.
private struct RailBar: View {
  let attributes: JourneyAttributes
  let state: JourneyAttributes.ContentState

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(.secondary)
        .frame(width: 7, height: 7)

      GeometryReader { geometry in
        let width = geometry.size.width
        let total = max(attributes.totalSeconds, 1)

        ZStack(alignment: .leading) {
          HStack(spacing: 0) {
            ForEach(Array(attributes.segments.enumerated()), id: \.offset) { _, segment in
              Rectangle()
                .fill(Color(journeyHex: segment.colorHex))
                .frame(width: max(2, width * segment.seconds / total))
            }
          }
          .frame(height: 5)
          .clipShape(Capsule())

          ForEach(Array(attributes.pointSeconds.enumerated()), id: \.offset) { _, atSeconds in
            Diamond()
              .fill(.primary)
              .frame(width: 8, height: 8)
              .offset(x: clamp(width * atSeconds / total - 4, width - 8))
          }

          Image(systemName: state.vehicleSymbol)
            .font(.system(size: 8, weight: .black))
            .foregroundStyle(.black)
            .frame(width: 14, height: 14)
            .background(.white, in: Circle())
            .offset(x: clamp(width * state.progress - 7, width - 14))
        }
        .frame(height: 14)
      }
      .frame(height: 14)

      Image(systemName: "flag.checkered")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(.secondary)
    }
  }

  /// Keeps the two endpoints pinned: an ornament half off the rail reads as a
  /// rendering bug rather than as the start or the end of a journey.
  private func clamp(_ value: Double, _ maximum: Double) -> Double {
    min(max(value, 0), max(maximum, 0))
  }
}

private struct Diamond: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.midX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
    path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
    path.closeSubpath()
    return path
  }
}

// MARK: - The status line

/// One supporting line, and the acknowledge button when there is something to
/// acknowledge.
///
/// Every word here arrived over the bridge already translated. This target
/// composes no sentence of its own -- it used to build "<stop> · <time>",
/// which was `journey.offAt` reimplemented without words, and therefore free
/// to drift from the key the rest of the app reads.
private struct Footer: View {
  let attributes: JourneyAttributes
  let state: JourneyAttributes.ContentState

  var body: some View {
    HStack(spacing: 8) {
      if state.alerting, let title = state.alertTitle {
        VStack(alignment: .leading, spacing: 1) {
          Text(title)
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Color(journeyHex: journeyAlertColorHex))
            .lineLimit(1)
          if let body = state.alertBody, !body.isEmpty {
            Text(body)
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 4)
        Button(intent: AcknowledgeAlightIntent()) {
          Image(systemName: "checkmark")
            .font(.system(size: 14, weight: .black))
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(Text(AcknowledgeAlightIntent.title))
      } else {
        // The destination label is the rider's own words for where they are
        // going, so it stands in on the phases whose copy has no supporting
        // line rather than leaving the row empty.
        Text(state.supporting ?? attributes.destinationLabel)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Spacer(minLength: 0)
      }
    }
  }
}

// MARK: - Lock Screen / StandBy

private struct JourneyCard: View {
  let attributes: JourneyAttributes
  let state: JourneyAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 8) {
        RouteBadge(state: state, compact: false)
        // The hero, in the rider's language, at the size the spec asks for:
        // one line read off a locked phone at arm's length.
        Text(state.hero)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
        Spacer(minLength: 8)
        HeroNumber(state: state)
      }
      RailBar(attributes: attributes, state: state)
      Footer(attributes: attributes, state: state)
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
