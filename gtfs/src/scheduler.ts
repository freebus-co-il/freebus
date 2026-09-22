import { Cron } from "croner";
import type { ImportOutcome } from "./pipeline/importFeed.js";

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  outcome: ImportOutcome | { status: "error"; message: string };
}

export interface ImportRunnerOptions {
  /**
   * Backstop ceiling on a whole run, in ms. Defaults to 30 minutes; a real
   * import takes ~53 s. See #runWithTimeout for why this exists even though
   * the fetch layer has its own stall timeout.
   */
  runTimeoutMs?: number;
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

/** Thrown when a run exceeds the backstop ceiling. */
export class ImportTimeoutError extends Error {
  constructor(ms: number) {
    super(`import did not complete within ${ms}ms`);
    this.name = "ImportTimeoutError";
  }
}

/**
 * Serialises imports. Overlapping triggers — cron firing while a manual
 * refresh is in flight — share the same in-flight promise rather than starting
 * a second multi-gigabyte load.
 */
export class ImportRunner {
  readonly #importFn: () => Promise<ImportOutcome>;
  readonly #runTimeoutMs: number;
  #inFlight: Promise<ImportOutcome> | null = null;
  #last: RunRecord | null = null;

  constructor(
    importFn: () => Promise<ImportOutcome>,
    opts: ImportRunnerOptions = {},
  ) {
    this.#importFn = importFn;
    this.#runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  isRunning(): boolean {
    return this.#inFlight !== null;
  }

  lastResult(): RunRecord | null {
    return this.#last;
  }

  run(): Promise<ImportOutcome> {
    if (this.#inFlight) return this.#inFlight;

    const startedAt = new Date().toISOString();
    const p = (async () => {
      try {
        const outcome = await this.#runWithTimeout();
        this.#last = { startedAt, finishedAt: new Date().toISOString(), outcome };
        return outcome;
      } catch (err) {
        this.#last = {
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: { status: "error", message: (err as Error).message },
        };
        throw err;
      } finally {
        this.#inFlight = null;
      }
    })();

    this.#inFlight = p;
    return p;
  }

  /**
   * Races the import against a ceiling so the single-flight lock can never
   * be held forever.
   *
   * The fetch layer's stall timeout already covers the common wedge (a
   * download that goes silent), but it cannot cover every one. A zip entry
   * that ends short is the counter-example that motivated this: the body
   * arrives complete and the socket closes cleanly, and *then* unzipper's
   * `for await` neither yields another entry nor completes. No stream is
   * idle, no error is raised, nothing to abort. Without a ceiling here that
   * run's promise never settles, `#inFlight` is never cleared, `isRunning()`
   * stays true forever, and every later cron tick and `POST /refresh` either
   * joins the dead promise or gets a 409 — while `/health` keeps answering
   * 200 and nothing pages anyone. A crash costs one night and a supervisor
   * restarts it; this wedge is silent and self-perpetuating, so the backstop
   * is deliberately cause-agnostic: whatever the reason, the lock is
   * released and the next tick gets a fresh attempt.
   *
   * What this does NOT do is cancel the underlying import — nothing in the
   * pipeline is cancellable, so the wedged run keeps its build database and
   * its memory until the process restarts. That build file is named for its
   * own version stamp and carries the `.building` suffix, so it can never
   * collide with, or be mistaken for, the version a later run publishes; it
   * is swept at the start of a subsequent run.
   */
  async #runWithTimeout(): Promise<ImportOutcome> {
    const started = this.#importFn();
    // The race's loser has no awaiter; keep a rejection from surfacing as an
    // unhandled rejection minutes after the run was already given up on.
    started.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ImportTimeoutError(this.#runTimeoutMs)),
            this.#runTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface Schedule {
  stop(): void;
  nextRun(): Date | null;
}

export interface ScheduleOptions {
  /**
   * Upper bound of a uniform random delay applied to each tick, in ms.
   * Defaults to 0 (fire immediately on the tick).
   */
  jitterMs?: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Arms the cron.
 *
 * Jitter: the feed is a single shared government endpoint and 03:00 local is
 * the obvious hour for every consumer of it to pick, so each tick waits a
 * uniform random slice of `jitterMs` before firing rather than adding to a
 * synchronised burst on the second. This costs nothing here — the import is
 * nightly and nothing downstream cares whether it lands at 03:00 or 03:04.
 *
 * A pending jitter delay is cancelled by `stop()`. Leaving it armed would
 * make shutdown kick off a fresh multi-gigabyte import moments after the
 * server closed, which is the opposite of what stopping a schedule means.
 */
export function startSchedule(
  runner: ImportRunner,
  cron: string,
  timezone: string,
  onError: (err: unknown) => void,
  opts: ScheduleOptions = {},
): Schedule {
  const jitterMs = opts.jitterMs ?? 0;
  const random = opts.random ?? Math.random;
  const pending = new Set<NodeJS.Timeout>();

  const job = new Cron(cron, { timezone }, () => {
    if (jitterMs <= 0) {
      runner.run().catch(onError);
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(timer);
      runner.run().catch(onError);
    }, Math.floor(random() * jitterMs));
    pending.add(timer);
  });

  return {
    stop: () => {
      job.stop();
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    },
    nextRun: () => job.nextRun(),
  };
}
