import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "./manager.js";
import type { TimetableIndex } from "./index.js";

const newDir = () => mkdtempSync(join(tmpdir(), "transit-mgr-"));

function stubIndex(version: string): TimetableIndex {
  return { version } as unknown as TimetableIndex;
}

test("starts empty and becomes ready after a rebuild", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const m = new IndexManager(dir, { buildFn: async () => stubIndex("v1") });
  assert.equal(m.state(), "empty");
  assert.equal(m.current(), null);
  await m.rebuild();
  assert.equal(m.state(), "ready");
  assert.equal(m.current()!.version, "v1");
  m.stop();
});

// Two concurrent rebuilds of an 84 MB index must not both run.
test("concurrent rebuilds share one build", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  let calls = 0;
  const m = new IndexManager(dir, {
    buildFn: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return stubIndex("v1"); },
  });
  await Promise.all([m.rebuild(), m.rebuild(), m.rebuild()]);
  assert.equal(calls, 1);
  m.stop();
});

// The old index must keep serving while the new one builds; a request landing
// mid-rebuild must never see null.
test("the previous index keeps serving during a rebuild", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  let release: (() => void) | undefined;
  const m = new IndexManager(dir, {
    buildFn: async () => {
      await new Promise<void>((r) => { release = r; });
      return stubIndex("v2");
    },
  });
  (m as unknown as { index: TimetableIndex | null }).index = stubIndex("v1");
  const pending = m.rebuild();
  assert.equal(m.current()!.version, "v1");
  release!();
  await pending;
  assert.equal(m.current()!.version, "v2");
  m.stop();
});

test("maybeReload rebuilds only when the symlink target changed", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  let calls = 0;
  const m = new IndexManager(dir, { buildFn: async () => { calls++; return stubIndex("v"); } });
  await m.rebuild();
  assert.equal(calls, 1);
  assert.equal(await m.maybeReload(), false);
  assert.equal(calls, 1);

  unlinkSync(join(dir, "gtfs.sqlite"));
  buildFixtureDb(dir, "2026-08-22T00-00-00-000Z");
  assert.equal(await m.maybeReload(), true);
  assert.equal(calls, 2);
  m.stop();
});

// Any cache keyed by trip/stop INDICES into one specific
// TimetableIndex (a realtime resolver's TripLookup, or predictions already
// resolved against it) must be invalidated before any request can see the
// new index -- see onIndexSwap's own doc comment. This only tests that the
// hook fires, with the freshly-swapped index, on every successful rebuild;
// realtime's own wiring test proves what it's used for.
test("onIndexSwap fires synchronously with the new index on every successful rebuild", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const swaps: TimetableIndex[] = [];
  const m = new IndexManager(dir, {
    buildFn: async () => stubIndex("v1"),
    onIndexSwap: (ix) => swaps.push(ix),
  });
  await m.rebuild();
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0], m.current());

  // A second rebuild against an UNCHANGED target still produces a fresh
  // TimetableIndex object (buildFn runs unconditionally) and must fire again
  // -- POST /admin/reload's whole point is "force it now".
  await m.rebuild();
  assert.equal(swaps.length, 2);
  assert.equal(swaps[1], m.current());
  m.stop();
});

// A failed build must never fire the hook: nothing was actually swapped.
test("onIndexSwap does not fire when a rebuild fails", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  let calls = 0;
  const m = new IndexManager(dir, {
    buildFn: async () => { throw new Error("boom"); },
    onIndexSwap: () => { calls++; },
  });
  await assert.rejects(m.rebuild(), /boom/);
  assert.equal(calls, 0);
  m.stop();
});

// realtime/wiring.ts's createRealtimeRuntime needs an already-constructed
// IndexManager (so its resolver can read .current()/.currentBundle()), but
// the hook IT returns must still reach the SAME manager -- setOnIndexSwap
// is what closes that loop, registered after construction rather than at it.
test("setOnIndexSwap registers the hook after construction, and it still fires on rebuild", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const swaps: TimetableIndex[] = [];
  const m = new IndexManager(dir, { buildFn: async () => stubIndex("v1") });
  m.setOnIndexSwap((ix) => swaps.push(ix));
  await m.rebuild();
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0], m.current());

  // Clearing it (passing null) must stop further notifications.
  m.setOnIndexSwap(null);
  await m.rebuild();
  assert.equal(swaps.length, 1, "no further swaps after clearing the hook");
  m.stop();
});

// A build that throws must not wedge the manager into "building" forever.
test("a failed rebuild releases the lock and keeps the old index", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  let fail = true;
  const m = new IndexManager(dir, {
    buildFn: async () => { if (fail) throw new Error("boom"); return stubIndex("v2"); },
  });
  await assert.rejects(m.rebuild(), /boom/);
  assert.equal(m.state(), "empty");
  fail = false;
  await m.rebuild();
  assert.equal(m.state(), "ready");
  m.stop();
});

// The real worker path (no buildFn override) is exercised nowhere else in
// this suite — every other test injects an in-process buildFn precisely to
// avoid spawning a worker per test. That means a regression in the actual
// worker spawn/transfer path (e.g. the tsx-under-worker-threads module
// resolution `spawnBuildWorker` works around, or the transfer-list dedup in
// buildWorker.ts) would go unnoticed without this one. It intentionally runs
// under `npm test`'s tsx runtime, which is exactly the environment where
// that module resolution can fail.
test("the real worker builds a real index from a fixture db", async () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const m = new IndexManager(dir);
  await m.rebuild();
  assert.equal(m.state(), "ready");
  const idx = m.current()!;
  assert.equal(idx.version, "2026-08-21T16-10-22-006Z");
  assert.equal(idx.nStops, 4);
  assert.ok(idx.stopIdToIdx instanceof Map);
  assert.ok(idx.stopLat instanceof Float64Array);
  m.stop();
});
