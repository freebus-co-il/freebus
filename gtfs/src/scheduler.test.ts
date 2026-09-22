import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportRunner, startSchedule } from "./scheduler.js";
import type { ImportOutcome } from "./pipeline/importFeed.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `predicate` until it's true or `timeoutMs` elapses, then throws.
 * Used instead of a fixed sleep for "eventually true" assertions against
 * croner's real wall-clock ticks: croner fires "* * * * * *" on absolute
 * second boundaries, not relative to when the test starts, so time-to-first-
 * tick is uniform over (0, 1000ms) — a fixed wait sized for the average case
 * leaves too little slack for the worst case on a loaded CI box. Polling
 * removes the wall-clock dependency and typically finishes faster than a
 * fixed wait sized to cover the worst case.
 */
async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 3000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await settle(intervalMs);
  }
}

test("single-flight: a concurrent run reuses the in-flight promise", async () => {
  let calls = 0;
  const runner = new ImportRunner(async () => {
    calls++;
    await settle(50);
    return { status: "unchanged" as const };
  });

  const [a, b] = await Promise.all([runner.run(), runner.run()]);
  assert.equal(calls, 1, "second call must not start a second import");
  assert.equal(a.status, "unchanged");
  assert.equal(b.status, "unchanged");
});

test("isRunning reflects the in-flight state", async () => {
  const runner = new ImportRunner(async () => {
    await settle(30);
    return { status: "unchanged" as const };
  });
  assert.equal(runner.isRunning(), false);
  const p = runner.run();
  assert.equal(runner.isRunning(), true);
  await p;
  assert.equal(runner.isRunning(), false);
});

test("records the last result including failures", async () => {
  const runner = new ImportRunner(async () => {
    throw new Error("upstream exploded");
  });
  await assert.rejects(runner.run(), /exploded/);
  const last = runner.lastResult();
  assert.equal(last?.outcome.status, "error");
  assert.match(String((last!.outcome as { message: string }).message), /exploded/);
});

test("a failed run does not wedge the lock", async () => {
  let calls = 0;
  const runner = new ImportRunner(async () => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return { status: "unchanged" as const };
  });
  await assert.rejects(runner.run());
  const second = await runner.run();
  assert.equal(second.status, "unchanged");
  assert.equal(calls, 2);
});

// --- Scheduler-firing coverage -------------------------------------------
//
// The tests above only exercise ImportRunner directly; none of them prove
// that startSchedule ever invokes the runner. A stub `startSchedule` that
// returns `{ stop(){}, nextRun(){return null} }` and never calls `runner.run()`
// would pass every test above. These tests use a real second-level croner
// expression against a stub import function (never the real pipeline) so
// they stay fast, and prove both that the cron fires and that stop() is
// effective.
//
// Timing note: croner fires "* * * * * *" on absolute wall-clock second
// boundaries, not relative to test start, so time-to-first-tick is uniform
// over (0, 1000ms). The "prove it fires" assertions below poll for the
// condition (bounded by a generous ceiling) rather than sleeping a fixed
// duration, so they have no dependency on how close to a boundary the test
// happened to start. The "prove stop() halts it" assertion is a negative
// (no more ticks) and can't be turned into a poll — it uses a fixed wait,
// but a generous one (comfortably over one second, i.e. more than a full
// cron period) so a stray GC pause can't produce a false pass.

test("startSchedule actually triggers runs on its cron tick", async () => {
  let calls = 0;
  const runner = new ImportRunner(async (): Promise<ImportOutcome> => {
    calls++;
    return { status: "unchanged" };
  });

  const schedule = startSchedule(runner, "* * * * * *", "UTC", () => {});
  try {
    // Two ticks is enough to prove wiring (not just a lucky single fire).
    await waitUntil(() => calls >= 2, { timeoutMs: 3000 });
  } finally {
    schedule.stop();
  }
});

test("stop() prevents further ticks from firing", async () => {
  let calls = 0;
  const runner = new ImportRunner(async (): Promise<ImportOutcome> => {
    calls++;
    return { status: "unchanged" };
  });

  const schedule = startSchedule(runner, "* * * * * *", "UTC", () => {});
  await waitUntil(() => calls >= 1, { timeoutMs: 2000 });

  schedule.stop();
  const callsAtStop = calls;
  // Proving a negative: wait comfortably longer than one cron period so a
  // still-pending tick would have had time to land if stop() were a no-op.
  await settle(2000);
  assert.equal(
    calls,
    callsAtStop,
    "no further ticks should fire once the schedule has been stopped",
  );
});

test("onError is invoked when a scheduled run rejects, without an unhandled rejection", async () => {
  let errors = 0;
  const runner = new ImportRunner(async (): Promise<ImportOutcome> => {
    throw new Error("scheduled failure");
  });

  const onUnhandled = () => {
    assert.fail("a rejected scheduled run must not produce an unhandled rejection");
  };
  process.once("unhandledRejection", onUnhandled);

  const schedule = startSchedule(runner, "* * * * * *", "UTC", () => {
    errors++;
  });
  try {
    await waitUntil(() => errors >= 1, { timeoutMs: 2000 });
  } finally {
    schedule.stop();
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

// --- Run-timeout backstop --------------------------------------------------
//
// The failure this exists for: a run whose promise never settles. #inFlight
// is never cleared, isRunning() stays true forever, and every subsequent cron
// tick and POST /refresh either joins the dead promise or gets a 409 — while
// /health keeps answering 200 and /status reports running: true. The nightly
// import stops permanently and nothing pages anyone. Ranked above the crash
// in review for exactly that reason: a crash gets restarted by a supervisor
// and costs one night; a wedge is invisible and self-perpetuating.
//
// The backstop is deliberately cause-agnostic. The fetch layer's stall
// timeout covers a download that goes silent, but not (for instance) a zip
// entry that ends short, where the socket closes cleanly and the archive
// reader simply never yields again — no stream idle, no error, nothing to
// abort.

test("a run that never settles rejects at the run timeout instead of wedging forever", async () => {
  const runner = new ImportRunner(
    () => new Promise<ImportOutcome>(() => { /* never settles */ }),
    { runTimeoutMs: 100 },
  );

  await assert.rejects(runner.run(), /did not complete within 100ms/);
  assert.equal(
    runner.isRunning(), false,
    "the single-flight lock must be released, or every later tick joins a dead promise",
  );
  const last = runner.lastResult();
  assert.equal(last?.outcome.status, "error");
  assert.match(String((last!.outcome as { message: string }).message), /did not complete/);
});

test("a wedged run does not prevent the next run from starting fresh", async () => {
  let calls = 0;
  const runner = new ImportRunner(
    async (): Promise<ImportOutcome> => {
      calls++;
      if (calls === 1) return new Promise<ImportOutcome>(() => {});
      return { status: "unchanged" };
    },
    { runTimeoutMs: 100 },
  );

  await assert.rejects(runner.run());
  // The whole point: the *next* nightly tick must get a real attempt, not a
  // 409 or a share of the promise that will never settle.
  const second = await runner.run();
  assert.equal(second.status, "unchanged");
  assert.equal(calls, 2);
});

test("a wedged run's late rejection does not surface as an unhandled rejection", async () => {
  // The abandoned import keeps running after the race is lost; when it
  // eventually fails there is no awaiter left. Without a handler attached at
  // race time that lands as an unhandled rejection minutes later, attributed
  // to nothing.
  let fail!: (err: Error) => void;
  const runner = new ImportRunner(
    () => new Promise<ImportOutcome>((_, reject) => { fail = reject; }),
    { runTimeoutMs: 50 },
  );

  const onUnhandled = () => {
    assert.fail("an abandoned run's rejection must not become an unhandled rejection");
  };
  process.once("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(runner.run());
    fail(new Error("the abandoned import finally gave up"));
    await settle(100);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("a healthy run well inside the ceiling is untouched", async () => {
  const runner = new ImportRunner(
    async (): Promise<ImportOutcome> => {
      await settle(60);
      return { status: "unchanged" };
    },
    { runTimeoutMs: 2000 },
  );
  assert.equal((await runner.run()).status, "unchanged");
});

// --- Cron jitter -----------------------------------------------------------
//
// The jitter exists because the feed is a single shared government endpoint:
// 03:00 is the obvious hour for every consumer to pick, so without jitter
// every client would hit it in the same instant. Nothing downstream cares
// whether a nightly import lands at 03:00 or 03:04.

test("jitter delays a tick's run rather than firing on the second", async () => {
  const firedAt: number[] = [];
  const runner = new ImportRunner(async (): Promise<ImportOutcome> => {
    firedAt.push(Date.now());
    return { status: "unchanged" };
  });

  // croner fires "* * * * * *" on absolute wall-clock second boundaries, so
  // without jitter every run lands within a few ms of `Date.now() % 1000 ===
  // 0`. random() is pinned to 1 so the delay is the full window and the
  // assertion is about the mechanism, not about luck: each run must land
  // roughly JITTER ms past its boundary. The tolerance is wide in both
  // directions so a loaded machine cannot produce a false failure — what it
  // cannot tolerate is a run firing ON the boundary, which is exactly the
  // no-jitter behaviour.
  const JITTER = 600;
  const schedule = startSchedule(runner, "* * * * * *", "UTC", () => {}, {
    jitterMs: JITTER, random: () => 1,
  });
  try {
    await waitUntil(() => firedAt.length >= 1, { timeoutMs: 5000 });
  } finally {
    schedule.stop();
  }

  const offset = firedAt[0]! % 1000;
  assert.ok(
    offset > JITTER / 2 && offset < JITTER + 350,
    `a jittered run must land ~${JITTER}ms past its cron boundary, not on it; `
    + `offset was ${offset}ms`,
  );
});

test("stop() cancels a jitter delay that has not fired yet", async () => {
  let calls = 0;
  const runner = new ImportRunner(async (): Promise<ImportOutcome> => {
    calls++;
    return { status: "unchanged" };
  });

  // A long jitter window guarantees the delay is still pending at stop().
  // Shutting down must not kick off a fresh multi-gigabyte import moments
  // after the server closed.
  const schedule = startSchedule(runner, "* * * * * *", "UTC", () => {}, {
    jitterMs: 5000, random: () => 1,
  });
  await settle(1200); // long enough for at least one tick to have armed a delay
  schedule.stop();
  await settle(500);
  assert.equal(calls, 0, "a pending jittered run must not fire after stop()");
});
