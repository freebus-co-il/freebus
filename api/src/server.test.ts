import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "./testing/fixture.js";
import { IndexManager } from "./transit/manager.js";
import { buildIndex } from "./transit/index.js";
import { buildServer, type ServerDeps } from "./server.js";
import { RealtimeStore } from "./realtime/store.js";

async function serve(extra: Partial<ServerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "transit-server-"));
  const link = buildFixtureDb(dir);
  // In-process build, like every other route test suite: the state machine
  // under test here is decoration/wiring, not the real worker path.
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, ...extra }), index };
}

// The realtime-gating and no-timer-armed guarantees themselves are tested
// directly against `resolveRealtimeConfig` (config.test.ts) and
// `createRealtimeRuntime` (realtime/wiring.test.ts) -- this file is scoped
// to what buildServer itself decorates, per its own comment on ServerDeps.
test("app.realtime is null by default -- buildServer never constructs a store or poller itself", async () => {
  const { app, index } = await serve();
  assert.equal(app.realtime, null);
  assert.equal(app.realtimeConsecutiveFailures, 0);
  await app.close(); index.stop();
});

test("app.realtime decorates the injected store when one is provided", async () => {
  const store = new RealtimeStore("siri-sm", 180);
  const { app, index } = await serve({ realtime: store });
  assert.equal(app.realtime, store);
  await app.close(); index.stop();
});

// `realtimePoller` is narrowed to `Pick<SiriPoller, "consecutiveFailures">`
// specifically so this can be read fresh on every request rather than
// captured once at server-build time -- a real poller's count changes
// after the server is built.
const NEVER_POLLED_STREAM_STATUSES = {
  "active-calls": { lastSuccessAt: null, failures: 0, lastError: null },
  planned: { lastSuccessAt: null, failures: 0, lastError: null },
};

test("app.realtimeConsecutiveFailures reads the injected poller's live count on every access", async () => {
  const realtimePoller = { consecutiveFailures: 2, streamStatuses: NEVER_POLLED_STREAM_STATUSES };
  const { app, index } = await serve({ realtimePoller });
  assert.equal(app.realtimeConsecutiveFailures, 2);
  realtimePoller.consecutiveFailures = 5;
  assert.equal(app.realtimeConsecutiveFailures, 5, "must not be captured once at decoration time");
  await app.close(); index.stop();
});

test("app.realtimeStreamStatuses defaults to the all-null/zero shape with no poller, and reads a real one live", async () => {
  {
    const { app, index } = await serve({});
    assert.deepEqual(app.realtimeStreamStatuses, NEVER_POLLED_STREAM_STATUSES);
    await app.close(); index.stop();
  }
  const streamStatuses = {
    "active-calls": { lastSuccessAt: 1_000, failures: 0, lastError: null },
    planned: { lastSuccessAt: null, failures: 3, lastError: "SIRI planned snapshot failed: boom" },
  };
  const realtimePoller = { consecutiveFailures: 3, streamStatuses };
  const { app, index } = await serve({ realtimePoller });
  assert.deepEqual(app.realtimeStreamStatuses, streamStatuses);
  await app.close(); index.stop();
});
