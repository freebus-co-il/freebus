import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { ImportRunner } from "../scheduler.js";
import { importFeed } from "../pipeline/importFeed.js";
import type { ImportOutcome } from "../pipeline/importFeed.js";
import { livePath } from "../db/swap.js";
import { buildFixtureZip } from "../testing/fixture.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newDir = () => mkdtempSync(join(tmpdir(), "gtfs-status-"));

function serve(buf: Buffer, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(buf, {
      status: 200,
      headers: { "content-type": "application/x-zip-compressed", ...headers },
    })) as unknown as typeof fetch;
}

test("GET /status reports idle before any run", async () => {
  const runner = new ImportRunner(async () => ({ status: "unchanged" as const }));
  const app = await buildServer({ runner });
  const res = await app.inject({ method: "GET", url: "/status" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { running: boolean; lastRun: unknown };
  assert.equal(body.running, false);
  assert.equal(body.lastRun, null);
  await app.close();
});

test("GET /status reflects a completed run's outcome", async () => {
  const runner = new ImportRunner(async () => ({ status: "unchanged" as const }));
  const app = await buildServer({ runner });
  await runner.run();
  const res = await app.inject({ method: "GET", url: "/status" });
  const body = res.json() as { running: boolean; lastRun: { outcome: ImportOutcome } | null };
  assert.equal(body.running, false);
  assert.equal(body.lastRun?.outcome.status, "unchanged");
  await app.close();
});

test("POST /refresh triggers a run and reports its outcome", async () => {
  let calls = 0;
  const runner = new ImportRunner(async () => {
    calls++;
    return { status: "unchanged" as const };
  });
  const app = await buildServer({ runner });
  const res = await app.inject({ method: "POST", url: "/refresh" });
  assert.equal(res.statusCode, 202);
  assert.equal((res.json() as { status: string }).status, "started");

  // The response is fire-and-forget (202 before the import finishes), but
  // the run must actually have been kicked off, not merely acknowledged.
  await settle(20);
  assert.equal(calls, 1, "POST /refresh must actually invoke the import function");
  await app.close();
});

test("POST /refresh returns 409 while a run is in flight, and never starts a second import", async () => {
  let calls = 0;
  const runner = new ImportRunner(async () => {
    calls++;
    await settle(150);
    return { status: "unchanged" as const };
  });
  const app = await buildServer({ runner });

  const first = await app.inject({ method: "POST", url: "/refresh" });
  assert.equal(first.statusCode, 202);

  // The first run's promise is assigned to the runner's in-flight slot
  // synchronously inside runner.run(), before this inject() call even
  // returns — so there is no race here despite the two awaits above and
  // below being separate microtask turns. The 150ms stub body just needs
  // to comfortably outlast the in-process HTTP round trip.
  const second = await app.inject({ method: "POST", url: "/refresh" });
  assert.equal(second.statusCode, 409);
  assert.equal((second.json() as { status: string }).status, "already_running");

  // The real assertion: only one import ever ran. If the 409 branch were
  // missing or miswired, this would catch it even if the status code
  // happened to still look right.
  await settle(200);
  assert.equal(calls, 1, "the second request must not have started its own import");
  await app.close();
});

test("GET /health stays responsive during a run", async () => {
  const runner = new ImportRunner(async () => {
    await settle(80);
    return { status: "unchanged" as const };
  });
  const app = await buildServer({ runner });
  await app.inject({ method: "POST", url: "/refresh" });
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  await app.close();
});

test("a rejected refresh run is recorded as an error and never surfaces as an unhandled rejection", async () => {
  const runner = new ImportRunner(async (): Promise<ImportOutcome> => {
    throw new Error("upstream exploded");
  });
  const app = await buildServer({ runner });

  const onUnhandled = () => {
    assert.fail("a rejected /refresh run must not produce an unhandled rejection");
  };
  process.once("unhandledRejection", onUnhandled);

  const res = await app.inject({ method: "POST", url: "/refresh" });
  assert.equal(res.statusCode, 202);

  await settle(20);
  const status = await app.inject({ method: "GET", url: "/status" });
  const body = status.json() as { running: boolean; lastRun: { outcome: { status: string; message: string } } };
  assert.equal(body.running, false);
  assert.equal(body.lastRun.outcome.status, "error");
  assert.match(body.lastRun.outcome.message, /exploded/);

  process.removeListener("unhandledRejection", onUnhandled);
  await app.close();
});

test("GET /status reports the persisted live database after a real import, surviving process restart", async () => {
  const dir = newDir();
  const imported = await importFeed({
    url: "https://x/f.zip",
    dataDir: dir,
    now: () => new Date("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(), { etag: '"e1"' }),
  });
  assert.equal(imported.status, "imported");

  // A brand-new runner with no in-memory history, exactly like a freshly
  // restarted process would have: lastRun is null, but /status must still
  // report the database that is actually live on disk. If `live` were
  // wired up from in-process state (or not wired up at all), this would
  // stay null even though a real import completed and published a
  // database this test can see on disk.
  const runner = new ImportRunner(async () => ({ status: "unchanged" as const }));
  const app = await buildServer({ runner, dataDir: dir });
  const res = await app.inject({ method: "GET", url: "/status" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    lastRun: unknown;
    live: {
      version: string; fetchedAt: string; sourceUrl: string;
      etag: string; counts: Record<string, number>; badRows: number; path: string;
    } | null;
    liveError: string | null;
  };
  assert.equal(body.lastRun, null, "in-process state must be empty, as after a restart");
  assert.ok(body.live, "live must be populated from the persisted database, not in-process state");
  assert.equal(body.live?.etag, '"e1"');
  assert.equal(body.live?.counts.stops, 2);
  assert.equal(body.live?.badRows, 0);
  assert.equal(body.live?.sourceUrl, "https://x/f.zip");
  assert.ok(body.live?.version, "version stamp must be present");
  assert.ok(body.live?.fetchedAt, "fetchedAt must be present");
  assert.ok(body.live?.path.includes(dir), "path must point at the resolved version file");
  assert.equal(body.liveError, null, "a healthy live database must report no liveError");
  await app.close();
});

test("GET /status reports live: null and liveError: null on a cold start with no published database", async () => {
  const dir = newDir(); // never imported into
  const runner = new ImportRunner(async () => ({ status: "unchanged" as const }));
  const app = await buildServer({ runner, dataDir: dir });
  const res = await app.inject({ method: "GET", url: "/status" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { live: unknown; liveError: unknown };
  assert.equal(body.live, null, "cold start must report live: null, not an error or stale data");
  // The field that distinguishes cold start from broken: on a genuine
  // cold start there is nothing wrong, so liveError must also be null. If
  // this were ever conflated with the broken-symlink case below (e.g. by
  // reporting some generic "not available" string here too), an operator
  // would have no way to tell "wait for the first import" from "a
  // database used to be live and is now gone."
  assert.equal(body.liveError, null, "cold start is not an error and must not populate liveError");
  await app.close();
});

test("GET /status still responds 200 (not 500), and reports liveError distinctly from a cold start, when the live symlink points at a missing file", async () => {
  const dir = newDir();
  // Simulate a broken/mid-swap symlink: points at a version file that was
  // never written (or was already garbage-collected out from under it).
  symlinkSync("gtfs-does-not-exist.sqlite", livePath(dir));

  const runner = new ImportRunner(async () => ({ status: "unchanged" as const }));
  const app = await buildServer({ runner, dataDir: dir });
  const res = await app.inject({ method: "GET", url: "/status" });

  // The real defect this guards against: openReadDb's fileMustExist:true
  // throws on a dangling symlink. If that throw ever escaped the route
  // handler uncaught, this request would 500 instead of 200 — the one
  // thing an ops status endpoint must never do during an incident.
  assert.equal(res.statusCode, 200, "a broken live symlink must not crash the status endpoint");
  const body = res.json() as { live: unknown; liveError: unknown };
  assert.equal(body.live, null);
  // This is the assertion the previous version of this test lacked: `live:
  // null` alone is identical to the cold-start response above, which would
  // wrongly tell an operator "nothing published yet" when a database was
  // in fact published and is now unreadable. liveError must be a non-null,
  // short reason string — proof the two states are actually distinguishable
  // in the JSON, not just that the endpoint avoided a 500.
  assert.equal(typeof body.liveError, "string", "a broken live symlink must populate liveError");
  assert.match(body.liveError as string, /unreadable/i);
  // Must not leak a raw stack trace or full error object into the response.
  assert.ok(
    (body.liveError as string).length < 200,
    "liveError must be a short reason, not a dumped error/stack",
  );
  await app.close();
});
