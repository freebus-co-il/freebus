import type { JourneyState, LiveJourneyInput } from '../types';

/**
 * When an active journey asks the planner again. Events first -- the plan
 * broke, a connection won't hold, the live arrival moved -- and otherwise a
 * slow steady beat while the rider still has a choice to make (which bus to
 * catch). All of it under one throttle: `/plan` is the most expensive call on
 * a small box, shared per IP.
 */

export type ReplanReason = 'off-plan' | 'connection-broken' | 'live-shift' | 'steady';

export type ReplanMemory = {
  lastRunAt: number | null;
  lastSwitchAt: number | null;
  inFlight: boolean;
  /** The journey's arrival as it stood after the last plan, for spotting a
   *  live shift since. */
  arrivalAtLastPlan: string | null;
};

export const REPLAN_THROTTLE_MS = 45_000;
export const STEADY_BEAT_MS = 120_000;
export const LIVE_SHIFT_SECONDS = 120;

const CHOOSING_PHASES = new Set<JourneyState['phase']>(['walking-to-stop', 'waiting', 'transferring']);

export function replanReason(args: {
  state: JourneyState;
  live: LiveJourneyInput | null;
  memory: ReplanMemory;
  nowMs: number;
}): ReplanReason | null {
  const { state, live, memory, nowMs } = args;
  if (memory.inFlight || state.phase === 'arrived') return null;
  if (memory.lastRunAt !== null && nowMs - memory.lastRunAt < REPLAN_THROTTLE_MS) return null;

  if (state.offPlan !== null) return 'off-plan';
  if (live?.connections.some((connection) => connection.holds === false)) return 'connection-broken';
  if (
    memory.arrivalAtLastPlan !== null &&
    Math.abs(Date.parse(state.arrivalTime) - Date.parse(memory.arrivalAtLastPlan)) >= LIVE_SHIFT_SECONDS * 1000
  ) {
    return 'live-shift';
  }
  if (CHOOSING_PHASES.has(state.phase) && (memory.lastRunAt === null || nowMs - memory.lastRunAt >= STEADY_BEAT_MS)) {
    return 'steady';
  }
  return null;
}
