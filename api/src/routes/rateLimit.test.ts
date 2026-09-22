import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex, attachFootpaths } from "../transit/index.js";
import { buildFootpaths } from "../transit/footpaths.js";
import { buildServer } from "../server.js";
import { routeRateLimits } from "../config.js";

/**
 * One file for all four RAPTOR-backed per-route limits (`routeRateLimits`
 * in `../config.js`), not one file per route: they are one family -- see
 * that object's own doc comment -- and a reader checking that the family is
 * complete, or debugging why one route's budget behaves oddly, should be
 * able to find every one of these tests in the same place. Named
 * `rateLimit.test.ts`, not `plan.rateLimit.test.ts`, now that it is not
 * `/plan`-specific.
 *
 * Every test here exists to burn a route's entire per-minute budget on
 * purpose, which is a fundamentally different thing from every other test
 * in this directory -- each one therefore gets its OWN `serve()` instance,
 * so it never shares a rate-limit store with a test elsewhere that still
 * needs that route to answer `200`. `@fastify/rate-limit`'s in-memory
 * store is per Fastify instance, so separate `serve()` calls never
 * accumulate against each other.
 *
 * IMPORTANT for anyone tempted to lower one of `routeRateLimits`'s
 * defaults a lot: `plan.test.ts` and its siblings are files among several
 * sharing this process, and while each test below gets its own instance
 * (so THOSE never interfere), a default set at or below the request count
 * any single ordinary test issues against that route would make this file
 * itself start failing outright the moment such a test runs against the
 * same instance. Every default here (60, 120, 60, 120) leaves headroom
 * over the at-most-2-request usage every existing test for these routes
 * makes.
 */

/**
 * `/plan` needs footpaths attached (it resolves walking access), so it gets
 * its own `serve()`, matching `plan.test.ts`'s own setup exactly. None of
 * the other three routes exercised below touch footpaths for the fixture
 * queries this file issues, so they share the plainer `serveLite()`.
 */
async function servePlan() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-ratelimit-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

async function serveLite() {
  const dir = mkdtempSync(join(tmpdir(), "transit-ratelimit-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

const PLAN_URL =
  "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00";
const JOURNEY_CHECK_URL =
  "/journey/check?leg=T1,1000,2000&at=2026-08-24T07:30:00%2B03:00";
const PLAN_ONBOARD_URL =
  "/plan/onboard?onTrip=T1&onTripFromStop=1000&to=stop:2000&at=2026-08-24T07:30:00%2B03:00";
const SEGMENTS_URL =
  "/segments?from=1000&to=2000&after=2026-08-24T07:00:00%2B03:00";

test("/plan's per-route limit bites once the configured budget is spent", async () => {
  const { app, index } = await servePlan();
  try {
    const max = routeRateLimits.planPerMinute;
    let last;
    for (let i = 0; i < max + 1; i++) {
      last = await app.inject({ url: PLAN_URL });
    }
    assert.equal(last!.statusCode, 429);
  } finally { await app.close(); index.stop(); }
});

test("/journey/check's per-route limit bites once the configured budget is spent", async () => {
  const { app, index } = await serveLite();
  try {
    const max = routeRateLimits.journeyCheckPerMinute;
    let last;
    for (let i = 0; i < max + 1; i++) {
      last = await app.inject({ url: JOURNEY_CHECK_URL });
    }
    assert.equal(last!.statusCode, 429);
  } finally { await app.close(); index.stop(); }
});

test("/plan/onboard's per-route limit bites once the configured budget is spent", async () => {
  const { app, index } = await serveLite();
  try {
    const max = routeRateLimits.planOnboardPerMinute;
    let last;
    for (let i = 0; i < max + 1; i++) {
      last = await app.inject({ url: PLAN_ONBOARD_URL });
    }
    assert.equal(last!.statusCode, 429);
  } finally { await app.close(); index.stop(); }
});

test("/segments's per-route limit bites once the configured budget is spent", async () => {
  const { app, index } = await serveLite();
  try {
    const max = routeRateLimits.segmentsPerMinute;
    let last;
    for (let i = 0; i < max + 1; i++) {
      last = await app.inject({ url: SEGMENTS_URL });
    }
    assert.equal(last!.statusCode, 429);
  } finally { await app.close(); index.stop(); }
});

// The property that makes these PER-ROUTE limits rather than one shared,
// tighter global limit, and the one most likely to regress silently:
// exhausting one route's own budget must not touch a DIFFERENT route's
// separate budget, even though both are RAPTOR-backed and both sit under
// the same `@fastify/rate-limit` plugin instance registered once in
// `server.ts`. Exhausts `/plan` and shows `/segments` -- a different entry
// in `routeRateLimits`, not the unlimited global pool -- still answers.
test("exhausting one route's per-route limit does not touch another route's separate budget", async () => {
  const { app, index } = await servePlan();
  try {
    const max = routeRateLimits.planPerMinute;
    for (let i = 0; i < max; i++) {
      await app.inject({ url: PLAN_URL });
    }
    const exhausted = await app.inject({ url: PLAN_URL });
    assert.equal(exhausted.statusCode, 429);

    const segments = await app.inject({ url: SEGMENTS_URL });
    assert.equal(segments.statusCode, 200);
  } finally { await app.close(); index.stop(); }
});
