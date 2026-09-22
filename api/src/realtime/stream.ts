/**
 * The interval, backoff and lifecycle machinery every realtime poller
 * shares. Extracted from `poller.ts` when the Stride SIRI-VM fallback
 * arrived needing exactly this timing behaviour and none of that file's
 * SIRI-SM specifics -- API-key redaction, `StopMonitoringDelivery`
 * validation, the two-stream merge.
 *
 * Knows nothing about HTTP, SIRI, or resolution: `tick` is an opaque
 * "do the work, report whether it worked" callback.
 */

/**
 * ICD §7.18.2: a snapshot request must not be made more often than once
 * every 15 seconds. Every configured interval is clamped UP to this floor,
 * never down -- a misconfigured, too-eager interval must never reach MOT
 * faster than the ICD allows.
 */
const MIN_POLL_SECONDS = 15;

/**
 * Ceiling on the backed-off DELAY itself, not on the number of doubling
 * steps -- a step-count cap (e.g. "stop doubling after 6 failures") would
 * give the two streams different real ceilings, since their base
 * intervals differ (`REALTIME_POLL_SECONDS` default 30s vs.
 * `REALTIME_PLANNED_POLL_SECONDS` default 60s: 6 steps is 32 minutes for
 * one and 64 for the other), and would let an unusually short configured
 * interval escalate arbitrarily far too. Capping the delay directly gives
 * every stream, at every configured interval, the same worst case.
 *
 * Five minutes: a feed whose whole value is freshness cannot afford to go
 * blind through an entire legitimately quiet period -- overnight, most
 * plausibly, when `hasStopMonitoringDelivery` failing every tick because
 * the ministry's feed is genuinely empty would otherwise be the exact
 * failure mode that stays undetected longest -- and then take up to half
 * an hour (the old 6-step ceiling) to notice service resumed at the start
 * of the morning peak, which is precisely when it matters most. Five
 * minutes keeps repeated failures from hammering MOT while bounding how
 * long a real recovery goes unnoticed to something well inside a normal
 * shift. Doubling is still the right shape for the growth itself; the
 * ceiling is the part that needed to suit the data, not an arbitrary step
 * count. No jitter, no separate backoff module or class -- this constant
 * and the doubling in `Stream.afterTick` are the entire policy (YAGNI).
 */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Clamps a configured poll interval to the ICD floor -- Math.max alone
 * would let a non-finite `seconds` (NaN, +/-Infinity: e.g. a misconfigured
 * env var that reached here despite `resolveRealtimeConfig`'s own validation)
 * through as NaN, and `setTimeout(fn, NaN)` fires IMMEDIATELY, turning a typo
 * into a hot loop against MOT's rate limit. Config validation belongs to
 * `resolveRealtimeConfig`; this is the last line of defence before it.
 */
export function pollIntervalMs(seconds: number): number {
  const safe = Number.isFinite(seconds) ? seconds : MIN_POLL_SECONDS;
  return Math.max(MIN_POLL_SECONDS, safe) * 1000;
}

export interface PollerTimerHandle {
  unref?(): void;
}

/**
 * Stands in for the real `setTimeout`/`clearTimeout` so tests drive time
 * explicitly instead of waiting on real timers -- "a test that waits on a
 * 30-second interval is not a test". `setTimeout`'s callback may return a
 * promise: the real scheduler ignores it, but a test scheduler can capture
 * and await it to know exactly when one tick (including its async fetch)
 * has finished, without guessing at a number of microtask flushes.
 */
export interface PollerScheduler {
  setTimeout(fn: () => void | Promise<void>, ms: number): PollerTimerHandle;
  clearTimeout(handle: PollerTimerHandle): void;
}

export const REAL_SCHEDULER: PollerScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * One of the two national snapshot streams: its own interval, its own
 * consecutive-failure count, its own timer, entirely independent of the
 * other stream. Knows nothing about SIRI, HTTP, or resolution -- `tick` is
 * an opaque "do the work, report whether it worked" callback; this class
 * is purely the interval/backoff/lifecycle machinery.
 */
export class Stream {
  /**
   * Deliberately NOT reset by `stop()` or `start()` -- only a successful
   * tick resets it (see `afterTick`). A restart (process redeploy, a
   * future manual "reconnect" admin action, `stop()`+`start()`) is not
   * evidence the ministry's service has recovered, so a poller that had
   * backed off to its ceiling before restarting resumes AT that ceiling
   * rather than hammering MOT at the base interval immediately after
   * every restart during an ongoing outage.
   */
  private failures = 0;
  private handle: PollerTimerHandle | null = null;
  private running = false;
  /**
   * Bumped by every `start()`. A tick captures the generation it started
   * under; if `stop()` then `start()` happen while that tick is still in
   * flight (it holds no timer handle during the await, so `stop()` has
   * nothing of ITS to clear), the fresh `start()` arms its own timer and
   * bumps the generation. When the stale tick finishes, its generation no
   * longer matches, so it does not reschedule -- without this, it would
   * call `scheduleNext` and overwrite `this.handle` with a THIRD timer,
   * orphaning the fresh `start()`'s timer with no reference left to clear
   * it.
   */
  private generation = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly scheduler: PollerScheduler,
  ) {}

  get failureCount(): number {
    return this.failures;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.scheduleNext(this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    const generation = this.generation;
    const handle = this.scheduler.setTimeout(() => this.run(generation), delayMs);
    // Never hold the process open for a poll -- the same reason
    // IndexManager.startPolling unref()s its interval timer.
    handle.unref?.();
    this.handle = handle;
  }

  private async run(generation: number): Promise<void> {
    this.handle = null;
    let success: boolean;
    try {
      success = await this.tick();
    } catch {
      // Defense in depth only: `SiriPoller.tick` already catches
      // everything it does and never rejects. This guards the contract at
      // the `Stream` boundary itself, in case a future or test-only `tick`
      // does not.
      success = false;
    }
    this.afterTick(success, generation);
  }

  private afterTick(success: boolean, generation: number): void {
    // Either stop() ran while the tick was in flight, or a stop()+start()
    // cycle ran and this tick belongs to a generation that is no longer
    // current -- either way, this tick's outcome must not arm a timer.
    if (!this.running || generation !== this.generation) return;
    if (success) {
      this.failures = 0;
      this.scheduleNext(this.intervalMs);
    } else {
      // `failures` itself is left uncapped -- it is only ever used inside
      // `2 ** this.failures`, which is already clamped by MAX_BACKOFF_MS
      // below, so capping the counter too would be a second mechanism
      // doing the same job. (`2 ** this.failures` only reaches `Infinity`
      // after roughly 1024 consecutive failures -- at a saturated ~5-minute
      // cadence, several days of continuous failure -- and `Math.min`
      // handles `Infinity` correctly regardless.)
      this.failures++;
      this.scheduleNext(Math.min(this.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS));
    }
  }
}
