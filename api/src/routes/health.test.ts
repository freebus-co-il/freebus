import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";

test("GET /health reports ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-health-"));
  const link = buildFixtureDb(dir);
  // In-process buildFn: no need for a real worker in tests that don't
  // exercise the index itself. IndexManager opens its own db-derived bundle
  // from `dir` in its constructor -- no separate handle needed here.
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string; uptime: number };
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptime, "number");
  await app.close();
  index.stop();
});
