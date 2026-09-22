import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimetableIndex } from "./index.js";
import {
  candidatePairs, buildFootpaths, stopSetHash,
  saveFootpathCache, loadFootpathCache,
} from "./footpaths.js";

/** Four stops: 0 and 1 are ~110 m apart; 2 is ~11 km away; 3 is 0's platform. */
function fakeIndex(): TimetableIndex {
  return {
    nStops: 4,
    stopIds: ["a", "b", "c", "d"],
    stopLat: Float64Array.from([32.0000, 32.0010, 32.1000, 32.0001]),
    stopLon: Float64Array.from([34.8000, 34.8000, 34.8000, 34.8000]),
    stopParent: Int32Array.from([-1, -1, -1, 0]),
  } as unknown as TimetableIndex;
}

const opts = {
  maxMeters: 500, sameStationSeconds: 180, transferMinSeconds: 60,
  batchSize: 10, speedMps: 1.33,
};

test("candidatePairs finds near stops and excludes distant ones", () => {
  const pairs = candidatePairs(fakeIndex(), 500);
  assert.deepEqual(pairs.get(0)!.sort(), [1, 3]);
  // Stop 2 is 11 km away and has no candidates at all.
  assert.deepEqual(pairs.get(2) ?? [], []);
});

test("candidatePairs never pairs a stop with itself", () => {
  for (const [from, tos] of candidatePairs(fakeIndex(), 500)) {
    assert.ok(!tos.includes(from));
  }
});

test("builds footpaths from Valhalla results", async () => {
  const client = {
    ping: async () => true,
    matrix: async (s: unknown[], t: unknown[]) =>
      s.map(() => t.map(() => ({ distanceMeters: 120, durationSeconds: 90 }))),
  };
  const { arrays, mode } = await buildFootpaths(fakeIndex(), client as never, opts);
  assert.equal(mode, "valhalla");
  const from = arrays.offsets[0]!;
  const to = arrays.offsets[1]!;
  assert.ok(to > from);
  // 90 s of walking plus the 60 s boarding buffer.
  const idx = [...arrays.targets.slice(from, to)].indexOf(1);
  assert.equal(arrays.seconds[from + idx], 150);
});

// Valhalla's street network cannot model a walk between two platforms of one
// station; that pair gets the flat interchange cost instead.
test("same-station pairs use the flat interchange cost, not Valhalla", async () => {
  let matrixPairs = 0;
  const client = {
    ping: async () => true,
    matrix: async (s: unknown[], t: unknown[]) => {
      matrixPairs += s.length * t.length;
      return s.map(() => t.map(() => ({ distanceMeters: 120, durationSeconds: 90 })));
    },
  };
  const { arrays } = await buildFootpaths(fakeIndex(), client as never, opts);
  const from = arrays.offsets[0]!;
  const to = arrays.offsets[1]!;
  const idx = [...arrays.targets.slice(from, to)].indexOf(3);
  assert.equal(arrays.seconds[from + idx], 180 + 60);
  // The 0<->3 pair was never sent to Valhalla.
  assert.ok(matrixPairs < 4 * 4);
});

test("falls back to straight-line when Valhalla is down", async () => {
  const client = { ping: async () => false, matrix: async () => { throw new Error("down"); } };
  const { arrays, mode } = await buildFootpaths(fakeIndex(), client as never, opts);
  assert.equal(mode, "straight-line");
  assert.ok(arrays.targets.length > 0);
});

test("the cache round-trips and rejects a different stop set", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-foot-"));
  const arrays = {
    offsets: Int32Array.from([0, 1, 1, 1, 1]),
    targets: Int32Array.from([1]),
    seconds: Int32Array.from([150]),
  };
  const hash = stopSetHash(fakeIndex(), opts);
  saveFootpathCache(dir, hash, arrays);
  const back = loadFootpathCache(dir, hash);
  assert.ok(back);
  assert.deepEqual([...back.seconds], [150]);
  assert.equal(loadFootpathCache(dir, "someotherhash"), null);
});

// A larger, deliberately asymmetric array: if loadFootpathCache ever misreads
// byte offsets (e.g. views a pooled Buffer's underlying ArrayBuffer directly
// at a non-4-byte-aligned start instead of copying), values here would come
// back shifted or from the wrong section entirely -- not just "off by a
// little", since offsets/targets/seconds have different lengths and value
// ranges that make a shift obvious.
test("the cache round-trips a large asymmetric array without shifting bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-foot-big-"));
  const nStops = 5000;
  const offsets = new Int32Array(nStops + 1);
  const targets: number[] = [];
  const seconds: number[] = [];
  // Variable fan-out per stop (0..6 edges) so offsets are non-uniform, and
  // target/second values are distinguishable per-index so a shift is visible.
  for (let s = 0; s < nStops; s++) {
    offsets[s] = targets.length;
    const fanOut = s % 7;
    for (let k = 0; k < fanOut; k++) {
      targets.push((s + k + 1) % nStops);
      seconds.push(1000 + s * 10 + k);
    }
  }
  offsets[nStops] = targets.length;
  const arrays = {
    offsets,
    targets: Int32Array.from(targets),
    seconds: Int32Array.from(seconds),
  };

  const hash = "biggish";
  saveFootpathCache(dir, hash, arrays);
  const back = loadFootpathCache(dir, hash);
  assert.ok(back);
  assert.deepEqual([...back.offsets], [...arrays.offsets]);
  assert.deepEqual([...back.targets], [...arrays.targets]);
  assert.deepEqual([...back.seconds], [...arrays.seconds]);
});

/**
 * Two platforms of one station, ~1.11 km apart -- farther than the 500 m
 * `maxMeters` walking-radius prefilter used everywhere else in this file.
 * Stop 1's parent is stop 0, so they are the same station regardless of
 * distance; platform interchange is not a street walk, so its cost must
 * never depend on straight-line distance.
 */
function distantStationIndex(): TimetableIndex {
  return {
    nStops: 2,
    stopIds: ["station", "platform"],
    stopLat: Float64Array.from([32.0000, 32.0100]),
    stopLon: Float64Array.from([34.8000, 34.8000]),
    stopParent: Int32Array.from([-1, 0]),
  } as unknown as TimetableIndex;
}

test("a station whose platforms are farther apart than maxMeters still gets an interchange footpath both ways", async () => {
  const client = {
    ping: async () => true,
    // Same-station pairs must never reach Valhalla, so any call here is a bug.
    matrix: async () => { throw new Error("matrix should not be called for a same-station pair"); },
  };
  const { arrays } = await buildFootpaths(distantStationIndex(), client as never, opts);

  const flat = opts.sameStationSeconds + opts.transferMinSeconds;

  const from0 = arrays.offsets[0]!;
  const to0 = arrays.offsets[1]!;
  const idx0 = [...arrays.targets.slice(from0, to0)].indexOf(1);
  assert.ok(idx0 >= 0, "stop 0 should have a footpath to stop 1 despite the distance");
  assert.equal(arrays.seconds[from0 + idx0], flat);

  const from1 = arrays.offsets[1]!;
  const to1 = arrays.offsets[2]!;
  const idx1 = [...arrays.targets.slice(from1, to1)].indexOf(0);
  assert.ok(idx1 >= 0, "stop 1 should have a footpath back to stop 0 (symmetric)");
  assert.equal(arrays.seconds[from1 + idx1], flat);
});

/**
 * A pair that is BOTH a station peer (via stopParent) AND within the walking
 * radius must appear exactly once in each stop's adjacency list -- not once
 * from the station-peer pass and again from the street-candidate pass.
 */
test("a pair that is both a station peer and within the walking radius appears exactly once", async () => {
  const client = {
    ping: async () => true,
    matrix: async (s: unknown[], t: unknown[]) =>
      s.map(() => t.map(() => ({ distanceMeters: 20, durationSeconds: 15 }))),
  };
  // fakeIndex's stop 3 is stop 0's platform (~11 m apart) -- both a station
  // peer of 0 and well within the 500 m walking radius.
  const { arrays } = await buildFootpaths(fakeIndex(), client as never, opts);

  const from = arrays.offsets[0]!;
  const to = arrays.offsets[1]!;
  const occurrences = [...arrays.targets.slice(from, to)].filter((t) => t === 3).length;
  assert.equal(occurrences, 1);
});

test("finalizeSeconds guard: a misconfigured negative transferMinSeconds fails loudly instead of writing a negative duration", async () => {
  const client = {
    ping: async () => true,
    matrix: async (s: unknown[], t: unknown[]) =>
      s.map(() => t.map(() => ({ distanceMeters: 120, durationSeconds: 90 }))),
  };
  const badOpts = { ...opts, sameStationSeconds: 0, transferMinSeconds: -100000 };
  await assert.rejects(
    () => buildFootpaths(fakeIndex(), client as never, badOpts),
    /invalid footpath duration/,
  );
});

// The cache key has to cover the OPTIONS as well as the stop set, because
// every number in the cached arrays is a function of them: maxMeters decides
// which pairs exist, transferMinSeconds is added to every edge,
// sameStationSeconds is the whole cost of a station-peer edge, and speedMps
// scales every straight-line estimate. Keyed on the stop set alone, an
// operator could retune any of these, restart, and silently be served the
// arrays built with the OLD values -- with /meta still reporting
// `footpaths: "valhalla"`, so nothing signalled that the change had not
// taken effect.
test("a different walk option set produces a different cache key", () => {
  const ix = fakeIndex();
  const base = stopSetHash(ix, opts);
  for (const changed of [
    { ...opts, maxMeters: 900 },
    { ...opts, sameStationSeconds: 240 },
    { ...opts, transferMinSeconds: 90 },
    { ...opts, speedMps: 1.1 },
  ]) {
    assert.notEqual(stopSetHash(ix, changed), base, JSON.stringify(changed));
  }
  // Same options, same key -- otherwise a normal restart would never hit the
  // cache at all, which is the opposite failure.
  assert.equal(stopSetHash(ix, { ...opts }), base);
});

// batchSize only chunks the Valhalla matrix calls; it cannot change a single
// computed duration. Including it in the key would throw away a
// several-hundred-thousand-pair cache over an operational tuning knob.
test("batchSize does not participate in the cache key", () => {
  const ix = fakeIndex();
  // Assigned to variables rather than passed as fresh literals: the key type
  // deliberately omits `batchSize`, so a literal carrying it is an excess
  // property and would not compile -- which is itself part of the guarantee.
  const bigBatch = { ...opts, batchSize: 500 };
  const smallBatch = { ...opts, batchSize: 1 };
  assert.equal(stopSetHash(ix, bigBatch), stopSetHash(ix, smallBatch));
});

// The consequence that actually matters: two option sets must not read each
// other's cache file.
test("two option sets do not read each other's footpath cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-foot-opts-"));
  const ix = fakeIndex();
  const tight = { ...opts, maxMeters: 200 };
  const loose = { ...opts, maxMeters: 900 };

  saveFootpathCache(dir, stopSetHash(ix, tight), {
    offsets: Int32Array.from([0, 1, 1, 1, 1]),
    targets: Int32Array.from([1]),
    seconds: Int32Array.from([111]),
  });

  // Nothing has been written under the loose key, so it must MISS.
  assert.equal(loadFootpathCache(dir, stopSetHash(ix, loose)), null);
  // ...and the tight key must still find its own file.
  assert.deepEqual([...loadFootpathCache(dir, stopSetHash(ix, tight))!.seconds], [111]);
});
