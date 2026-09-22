import type { JourneySurfaceCopy } from './live-surface';
import type { JourneyState } from './types';

/** A prediction moving by less than this is not worth an update: the OS is
 *  already counting down to within a minute of the truth. */
export const DEADLINE_MOVE_MS = 60_000;

/**
 * The facts a live surface is actually drawn from. Everything else in a
 * `JourneyState` -- the timer range, the progress fraction -- the OS ticks by
 * itself from what it was last given, so a change in one buys nothing.
 *
 * The two resolved lines are in here as well, and they have to be: they are
 * the only thing on the surface that no OS primitive can re-derive. Switching
 * the app to Hebrew changes nothing about the state, so a comparison over
 * facts alone would leave the lock screen speaking English for the rest of the
 * ride. Comparing the strings rather than pushing unconditionally is what
 * keeps that from costing an update on every tick.
 *
 * The countdown's target can come from the timetable alone, or move under a
 * live prediction; a prediction that moves it by a minute or more is a
 * discovered fact, compared against what was last PUSHED so slow creep still
 * reaches the surface.
 *
 * Deliberately NOT here: `busStopsAway` and `stopsSource`. No OS surface
 * prints either -- only the in-app views and the PiP window do, and those
 * re-render off React state for free -- so comparing them would spend an
 * update on every stop a bus passes on its way to the rider, and on every
 * flip of the weak-fix thresholds, for nothing anyone on the lock screen sees.
 */
export type SurfaceFacts = Pick<JourneyState, 'phase' | 'legIndex' | 'stopsRemaining' | 'offPlan' | 'timeSource'> &
  Pick<JourneySurfaceCopy, 'hero' | 'supporting' | 'liveLabel'> & {
    /** The countdown's target in milliseconds since epoch. */
    deadlineMs: number | null;
  };

export function surfaceFacts(state: JourneyState, copy: JourneySurfaceCopy): SurfaceFacts {
  return {
    phase: state.phase,
    legIndex: state.legIndex,
    stopsRemaining: state.stopsRemaining,
    offPlan: state.offPlan,
    timeSource: state.timeSource,
    hero: copy.hero,
    supporting: copy.supporting,
    liveLabel: copy.liveLabel,
    deadlineMs: state.timer ? Date.parse(state.timer.to) : null,
  };
}

export function sameFacts(a: SurfaceFacts | null, b: SurfaceFacts): boolean {
  if (a === null) return false;
  // Compared against what was last PUSHED, so a prediction creeping thirty
  // seconds a poll still reaches the surface once it has crept a minute.
  const deadlineHeld =
    a.deadlineMs === null || b.deadlineMs === null
      ? a.deadlineMs === b.deadlineMs
      : Math.abs(a.deadlineMs - b.deadlineMs) < DEADLINE_MOVE_MS;
  return (
    deadlineHeld &&
    a.phase === b.phase &&
    a.legIndex === b.legIndex &&
    a.stopsRemaining === b.stopsRemaining &&
    a.offPlan === b.offPlan &&
    a.timeSource === b.timeSource &&
    a.hero === b.hero &&
    a.supporting === b.supporting &&
    a.liveLabel === b.liveLabel
  );
}
