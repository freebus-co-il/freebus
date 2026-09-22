import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ValhallaClient, straightLineWalk, withoutQuietSteps, type WalkStep } from "./valhalla.js";

/**
 * Runs `body` against a throwaway HTTP server answering every request with
 * `handler`'s return value, and CLOSES THAT SERVER WHETHER OR NOT `body`
 * THREW.
 *
 * The try/finally is the whole point: a helper that left each test to call
 * `close()` as its own last statement would leak a listening socket whenever
 * an assertion failed before that line — an open handle that keeps
 * `node --test`'s process alive after the run finishes, turning one honest
 * test failure into a hung suite with no output (the same class of bug that
 * leaked pino-pretty worker threads elsewhere in this codebase). A failing
 * test must fail loudly and fast; it must never take the runner down with it.
 */
async function withStub(
  handler: (body: unknown, url: string) => unknown,
  body: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const out = handler(raw === "" ? null : JSON.parse(raw), req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// Valhalla returns kilometres when units=kilometers. Reading that as metres
// understates every walk by 1000x and makes the whole network look adjacent.
test("matrix converts kilometres to metres", async () => {
  await withStub(() => ({
    sources_to_targets: [[{ from_index: 0, to_index: 0, distance: 0.42, time: 315 }]],
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const m = await client.matrix([[32.05, 34.78]], [[32.06, 34.78]]);
    assert.equal(m[0]![0]!.distanceMeters, 420);
    assert.equal(m[0]![0]!.durationSeconds, 315);
  });
});

test("matrix maps an unreachable pair to null", async () => {
  await withStub(() => ({
    sources_to_targets: [[{ from_index: 0, to_index: 0, distance: null, time: null }]],
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const m = await client.matrix([[32.05, 34.78]], [[32.06, 34.78]]);
    assert.equal(m[0]![0], null);
  });
});

test("route returns distance, duration and geometry", async () => {
  await withStub(() => ({
    trip: { legs: [{ shape: "_p~iF~ps|U", summary: { length: 0.32, time: 260 } }] },
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const r = await client.route([32.05, 34.78], [32.06, 34.78]);
    assert.equal(r.distanceMeters, 320);
    assert.equal(r.durationSeconds, 260);
    assert.equal(r.geometry, "_p~iF~ps|U");
    assert.equal(r.estimated, false);
  });
});

// A slow or dead container must degrade the answer, never fail the request.
test("route falls back to a straight-line estimate when Valhalla is unreachable", async () => {
  const client = new ValhallaClient({ url: "http://127.0.0.1:1", timeoutMs: 200 });
  const r = await client.route([32.0554, 34.78], [32.06, 34.78]);
  assert.equal(r.estimated, true);
  assert.ok(r.distanceMeters > 500 && r.distanceMeters < 800, `got ${r.distanceMeters}`);
  assert.equal(r.geometry, null);
});

test("ping reports false when Valhalla is unreachable", async () => {
  const client = new ValhallaClient({ url: "http://127.0.0.1:1", timeoutMs: 200 });
  assert.equal(await client.ping(), false);
});

// Straight-line underestimates real walking; the detour factor keeps the
// fallback from claiming journeys that are not actually walkable in time.
test("straightLineWalk applies a detour factor", () => {
  const w = straightLineWalk([32.0554, 34.78], [32.06, 34.78], 1.33);
  const crow = 512; // metres, approximately
  assert.ok(w.distanceMeters > crow * 1.3);
  assert.equal(w.estimated, true);
});

// from_index/to_index come from the server, not from us. A cell
// with an out-of-range index (in either dimension) must be ignored rather
// than growing the output past its requested, pre-populated dimensions.
test("matrix ignores cells whose from_index or to_index is out of range", async () => {
  await withStub(() => ({
    sources_to_targets: [[
      { from_index: 0, to_index: 99, distance: 0.5, time: 100 },
      { from_index: 99, to_index: 0, distance: 0.5, time: 100 },
    ]],
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const m = await client.matrix([[32.05, 34.78]], [[32.06, 34.78]]);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.length, 1);
    assert.equal(m[0]![0], null);
  });
});

// A 200 response whose summary is missing `length` must not
// silently produce NaN reported as a real, non-estimated distance.
test("route falls back to an estimate when summary.length is missing", async () => {
  await withStub(() => ({
    trip: { legs: [{ shape: "_p~iF~ps|U", summary: { time: 260 } }] },
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const r = await client.route([32.0554, 34.78], [32.06, 34.78]);
    assert.equal(Number.isFinite(r.distanceMeters), true);
    assert.equal(Number.isFinite(r.durationSeconds), true);
    assert.equal(r.estimated, true);
  });
});

// A response shaped so differently that a naive
// `json.trip.legs[0]` access would throw (no `trip` at all) must still
// come back as a finite, honestly-labelled estimate, not propagate the throw
// as if it were indistinguishable from a network failure.
test("route falls back to an estimate when the response shape doesn't parse at all", async () => {
  await withStub(() => ({ garbage: "not a valhalla response" }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const r = await client.route([32.0554, 34.78], [32.06, 34.78]);
    assert.equal(Number.isFinite(r.distanceMeters), true);
    assert.equal(Number.isFinite(r.durationSeconds), true);
    assert.equal(r.estimated, true);
    assert.equal(r.geometry, null);
  });
});

// ping() must not report healthy just because *something*
// answered 200 -- it decides whether the whole footpath matrix comes from
// real street routing or falls back to straight-line estimates network-wide.
test("ping reports false for a 200 response that isn't a Valhalla matrix result", async () => {
  await withStub(() => ({ garbage: "not valhalla" }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    assert.equal(await client.ping(), false);
  });
});

// A degenerate probe pair legitimately returning a
// null cell is still a healthy server and must not become a false negative.
test("ping reports true when the probe response has a null cell", async () => {
  await withStub(() => ({
    sources_to_targets: [[{ from_index: 0, to_index: 0, distance: null, time: null }]],
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    assert.equal(await client.ping(), true);
  });
});

// The guarantee itself: a body that throws mid-test must still leave no
// listening socket behind. Without the finally, this leaked handle is what
// hangs `node --test` after a genuine failure.
test("withStub closes its server even when the test body throws", async () => {
  let leakedUrl = "";
  await assert.rejects(
    withStub(() => ({ ok: true }), async (url) => {
      leakedUrl = url;
      throw new Error("assertion failed mid-test");
    }),
    /assertion failed mid-test/,
  );
  // Nothing is listening any more: the connection is refused rather than
  // answered. (A 200 here would mean the server outlived the throw.)
  await assert.rejects(fetch(leakedUrl, { signal: AbortSignal.timeout(1000) }));
});

// The turns a running journey guides a rider through. Valhalla's own numbers
// must become the app's vocabulary, and its kilometres metres.
test("route returns the walk's turns in the app's own vocabulary", async () => {
  await withStub(() => ({
    trip: { legs: [{
      shape: "_p~iF~ps|U",
      summary: { length: 0.52, time: 390 },
      maneuvers: [
        { type: 2, street_names: ["דרך הבנים"], length: 0.079, begin_shape_index: 0, end_shape_index: 3 },
        { type: 10, street_names: ["הדקלים"], length: 0.25, begin_shape_index: 3, end_shape_index: 9 },
        { type: 16, street_names: ["הרצל"], length: 0.1, begin_shape_index: 9, end_shape_index: 12 },
        { type: 40, street_names: [" "], length: 0.02, begin_shape_index: 12, end_shape_index: 13 },
        { type: 8, street_names: ["חרובים"], length: 0.07, begin_shape_index: 13, end_shape_index: 15 },
        { type: 4, length: 0, begin_shape_index: 15, end_shape_index: 15 },
      ],
    }] },
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const r = await client.route([32.05, 34.78], [32.06, 34.78]);
    assert.deepEqual(r.steps, [
      { maneuver: "depart", street: "דרך הבנים", lengthMeters: 79, beginShapeIndex: 0, endShapeIndex: 3 },
      { maneuver: "right", street: "הדקלים", lengthMeters: 250, beginShapeIndex: 3, endShapeIndex: 9 },
      { maneuver: "slight-left", street: "הרצל", lengthMeters: 100, beginShapeIndex: 9, endShapeIndex: 12 },
      { maneuver: "stairs", street: null, lengthMeters: 20, beginShapeIndex: 12, endShapeIndex: 13 },
      { maneuver: "straight", street: "חרובים", lengthMeters: 70, beginShapeIndex: 13, endShapeIndex: 15 },
      { maneuver: "arrive", street: null, lengthMeters: 0, beginShapeIndex: 15, endShapeIndex: 15 },
    ]);
  });
});

test("route skips a turn it cannot place rather than guessing where it is", async () => {
  await withStub(() => ({
    trip: { legs: [{
      shape: "_p~iF~ps|U",
      summary: { length: 0.3, time: 200 },
      maneuvers: [
        { type: 10, length: 0.1, begin_shape_index: 0 },
        { type: "right", length: 0.1, begin_shape_index: 0, end_shape_index: 2 },
        null,
        { type: 15, length: 0.2, begin_shape_index: 2, end_shape_index: 5 },
      ],
    }] },
  }), async (url) => {
    const client = new ValhallaClient({ url, timeoutMs: 1000 });
    const r = await client.route([32.05, 34.78], [32.06, 34.78]);
    assert.deepEqual(r.steps, [
      { maneuver: "left", street: null, lengthMeters: 200, beginShapeIndex: 2, endShapeIndex: 5 },
    ]);
  });
});

test("a straight-line estimate has no turns", () => {
  assert.deepEqual(straightLineWalk([32.05, 34.78], [32.06, 34.78], 1.33).steps, []);
});

test("bends that keep the rider on the same street, or onto an unnamed stub, are not turns", () => {
  const step = (maneuver: WalkStep["maneuver"], street: string | null, lengthMeters: number, begin: number, end: number): WalkStep =>
    ({ maneuver, street, lengthMeters, beginShapeIndex: begin, endShapeIndex: end });
  assert.deepEqual(withoutQuietSteps([
    step("depart", "חן", 35, 0, 2),
    step("right", "הדקלים", 175, 2, 6),
    step("slight-right", "הדקלים", 22, 6, 7),
    step("slight-right", null, 4, 7, 8),
    step("left", null, 19, 8, 9),
    step("slight-right", "הדקלים", 229, 9, 14),
    step("right", "דרך הבנים", 45, 14, 16),
    step("straight", "דרך הבנים", 10, 16, 17),
    step("slight-left", "הרצל", 30, 17, 19),
    step("arrive", null, 0, 19, 19),
  ]), [
    step("depart", "חן", 35, 0, 2),
    step("right", "הדקלים", 201, 2, 8),
    step("left", null, 19, 8, 9),
    step("slight-right", "הדקלים", 229, 9, 14),
    step("right", "דרך הבנים", 55, 14, 17),
    step("slight-left", "הרצל", 30, 17, 19),
    step("arrive", null, 0, 19, 19),
  ]);
});
