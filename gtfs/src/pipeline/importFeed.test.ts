import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureZip, FIXTURE_FILES } from "../testing/fixture.js";
import {
  importFeed, readFeedMeta, readLiveState, startupImportReason,
} from "./importFeed.js";
import { ImportRunner } from "../scheduler.js";
import { openReadDb } from "../db/open.js";
import { buildPathFor, buildingPathFor, resolveLive } from "../db/swap.js";

const ZIP_TYPE = "application/x-zip-compressed";
const newDir = () => mkdtempSync(join(tmpdir(), "gtfs-run-"));
const at = (iso: string) => () => new Date(iso);

function serve(buf: Buffer, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(buf, {
      status: 200,
      headers: { "content-type": ZIP_TYPE, ...headers },
    })) as unknown as typeof fetch;
}

test("imports the fixture archive end to end", async () => {
  const dir = newDir();
  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(), { etag: '"e1"' }),
  });

  assert.equal(r.status, "imported");
  if (r.status !== "imported") return;
  assert.equal(r.counts.stops, 2);
  assert.equal(r.counts.trips, 2);
  assert.equal(r.counts.stop_times, 3);
  assert.equal(r.counts.shapes, 1);
  assert.equal(r.badRows, 0);

  const live = resolveLive(dir);
  assert.ok(live, "live symlink must exist after a successful import");
});

test("a stop name's flipped geresh is fixed consistently in stops, routes, translations and search", async () => {
  // The real feed ships "'אידר א" for a sign reading "אידר א'", repeats it in
  // any route long name that stop opens, and keys its translations on that
  // same raw text. All of them must come out fixed together: fixing the stop
  // but not the translation key would silently orphan its English name.
  const flipped = {
    ...FIXTURE_FILES,
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id\n" +
      "1,38831,בי''ס בר לב/בן יהודה,רחוב: בן יהודה 74,32.183985,34.917554,0,,38831\n" +
      "2,38832,'אידר א,רחוב: אידר,32.795,35.012,0,,38832\n",
    "routes.txt":
      "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color\n" +
      "R1,2,1,בי''ס בר לב/בן יהודה-כפר סבא<->'אידר א-חיפה-1#,67001-1-#,3,FF0000\n" +
      "R2,2,2,'אידר א-חיפה<->בי''ס בר לב/בן יהודה-כפר סבא-2#,67002-1-#,3,\n",
    "translations.txt":
      "trans_id,lang,translation\n" +
      "'אידר א,HE,'אידר א\n" +
      "'אידר א,EN,Eder A\n",
  };
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(flipped)),
  });

  const db = openReadDb(resolveLive(dir)!);
  const name = (id: string) =>
    (db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(id) as { stop_name: string }).stop_name;
  assert.equal(name("2"), "אידר א'");
  assert.equal(name("1"), "בי''ס בר לב/בן יהודה", "gershayim inside a name must not move");

  const routes = db.prepare("SELECT route_long_name FROM routes ORDER BY route_id").all() as { route_long_name: string }[];
  assert.deepEqual(routes.map((r) => r.route_long_name), [
    "בי''ס בר לב/בן יהודה-כפר סבא<->אידר א'-חיפה-1#",
    "אידר א'-חיפה<->בי''ס בר לב/בן יהודה-כפר סבא-2#",
  ]);

  const translated = db.prepare(`
    SELECT t.lang, t.translation FROM stops s
    JOIN translations t ON t.trans_id = s.stop_name
    WHERE s.stop_id = ? ORDER BY t.lang
  `).all("2") as { lang: string; translation: string }[];
  assert.deepEqual(translated, [
    { lang: "EN", translation: "Eder A" },
    { lang: "HE", translation: "אידר א'" },
  ], "translations must still join on the fixed stop name");

  const indexed = db.prepare("SELECT stop_name FROM stops_fts WHERE stops_fts MATCH ?").all("אידר") as { stop_name: string }[];
  assert.deepEqual(indexed.map((r) => r.stop_name), ["אידר א'"]);
  db.close();
});

test("golden query: departures from a stop resolve through interned keys, including a past-midnight time", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });

  const db = openReadDb(resolveLive(dir)!);
  const rows = db.prepare(`
    SELECT t.trip_id, r.route_short_name, st.departure_time
    FROM stop_times st
    JOIN stops s  ON s.stop_ref  = st.stop_ref
    JOIN trips t  ON t.trip_ref  = st.trip_ref
    JOIN routes r ON r.route_id  = t.route_id
    WHERE s.stop_id = ?
    ORDER BY st.departure_time
  `).all("1") as { trip_id: string; route_short_name: string; departure_time: number }[];

  assert.deepEqual(rows.map((r) => r.trip_id), ["T1", "T2"]);
  assert.equal(rows[0]!.departure_time, 18600);
  // T2's stop_times.txt row is "25:30:00" — GTFS past-midnight notation for
  // a trip that departs after local midnight. It must survive coercion in
  // gtfs/values.ts, interning in FeedWriter, batched insertion, the sanity
  // gates, and the live-symlink swap unchanged: 25*3600 + 30*60 = 91800.
  // If any stage in that chain regressed (e.g. a naive HH:MM:SS parser that
  // clamps or wraps at 24h), this is the assertion that would catch it.
  assert.equal(rows[1]!.departure_time, 91800, "past-midnight time must survive");
  db.close();
});

test("skips the run when upstream reports 304", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(), { etag: '"e1"' }),
  });

  const second = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-22T03:00:00Z"),
    fetchImpl: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
  });
  assert.equal(second.status, "unchanged");
});

test("stores the feed version so the next run can send conditional headers", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(), { etag: '"abc"' }),
  });
  const meta = readFeedMeta(dir);
  assert.equal(meta.version?.etag, '"abc"');
  assert.equal(meta.counts?.stops, 2);
});

test("treats a stored empty-string etag as absent, not as a real conditional value", async () => {
  const dir = newDir();
  // No etag/last-modified header at all: fetchFeed's FeedVersion carries
  // null for both, and importFeed persists that as "" in feed_meta (see
  // setMeta.run("etag", result.version.etag ?? "")). readFeedMeta must
  // read that "" back as absent (null), not as a legitimate empty
  // conditional value — `Map#get(...) ?? null` would wrongly pass "" through
  // as truthy-looking-but-empty, and fetchFeed only skips the header on a
  // falsy check, so this specifically guards readFeedMeta's own contract
  // for any caller (health/status reporting, future conditional logic)
  // that trusts version.etag being null to mean "no conditional value".
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });

  const meta = readFeedMeta(dir);
  assert.equal(meta.version?.etag, null);
  assert.equal(meta.version?.lastModified, null);
});

test("rejects a run whose shapes.txt reappears after its shape_id group was flushed (non-contiguous shape)", async () => {
  const dir = newDir();
  // SH1's group (one point) is flushed as soon as the differing shape_id
  // SH2 is seen; SH1 then reappears with a second point. FeedWriter
  // discards that reappearance rather than corrupting the already-written
  // polyline, but the `shapes` table itself ends up with an SH1 row whose
  // point_count/total_length_m look complete and authoritative — nothing
  // queryable in the database reveals the truncation. Only
  // writer.nonContiguousShapeIds(), read from *this* writer instance and
  // passed into runSanityGates, can catch it. If importFeed ever stopped
  // wiring that argument through, this is the only test that would go red.
  const broken = {
    ...FIXTURE_FILES,
    "shapes.txt":
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
      "SH1,32.164723,34.848813,1\nSH2,32.1,34.8,1\nSH1,32.164738,34.848972,2\n",
  };

  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(broken)),
    // The reappearing SH1 points also count as bad rows (2 bad out of ~15
    // fixture rows > the default 0.01 ratio), which would reject the run
    // at the bad-row-ratio gate *before* runSanityGates ever runs. Setting
    // this to 1 disables that earlier gate so the assertion below actually
    // exercises Gate 5, not just "the run was rejected for some reason".
    maxBadRowRatio: 1,
  });

  assert.equal(r.status, "rejected");
  if (r.status !== "rejected") return;
  assert.ok(
    r.failures.some((f) => /SH1/.test(f) && /(non-contiguous|shape)/i.test(f)),
    `expected a shape-specific failure, got: ${r.failures.join("; ")}`,
  );
  assert.equal(resolveLive(dir), null, "no live database should ever have been published");
});

test("refuses to build over the live database when a fixed clock reproduces the same version stamp twice", async () => {
  const dir = newDir();
  const clock = at("2026-08-21T03:00:00Z");
  const first = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: clock,
    fetchImpl: serve(await buildFixtureZip()),
  });
  assert.equal(first.status, "imported");
  const before = resolveLive(dir);

  // A real cron never repeats a millisecond timestamp, but a test (or any
  // caller) injecting a fixed clock against the same dataDir can. Without
  // the version-collision guard, importFeed would call
  // cleanupBuild(buildPath) on a path that IS the live database's target,
  // deleting it before the new build even starts — turning a caller
  // mistake into silent data loss instead of a loud failure.
  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: clock,
      fetchImpl: serve(await buildFixtureZip()),
    }),
    /live/i,
  );

  assert.equal(resolveLive(dir), before, "the live database must survive the collision untouched");
  assert.ok(existsSync(before!), "the live database file itself must still exist on disk");
});

test("a rejected run leaves the previous database live and cleans up the partial build file", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  const before = resolveLive(dir);

  // A feed with no routes must fail the non-empty gate.
  const broken = { ...FIXTURE_FILES, "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color\n" };
  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-22T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(broken)),
  });

  assert.equal(r.status, "rejected");
  if (r.status !== "rejected") return;
  assert.ok(r.failures.some((f) => /routes/.test(f)));
  assert.equal(resolveLive(dir), before, "live database must not have moved");

  const leftoverBuilds = readdirSync(dir).filter(
    (f) => f.startsWith("gtfs-") && f.includes("2026-08-22"),
  );
  assert.deepEqual(leftoverBuilds, [], "the rejected run's partial build file must be cleaned up");
});

test("rejects a run whose bad-row ratio exceeds the threshold, and cleans up the partial build file", async () => {
  const dir = newDir();
  const broken = {
    ...FIXTURE_FILES,
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,shape_dist_traveled\n" +
      ",,,,,,,\n,,,,,,,\n,,,,,,,\n",
  };
  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip(broken)),
    maxBadRowRatio: 0.01,
  });
  assert.equal(r.status, "rejected");
  assert.equal(resolveLive(dir), null, "no live database should ever have been published");
  const leftoverBuilds = readdirSync(dir).filter((f) => f.startsWith("gtfs-"));
  assert.deepEqual(leftoverBuilds, [], "the rejected run's partial build file must be cleaned up");
});

test(
  "a garbage-collection failure after a successful swap must not undo the swap or fail the import",
  { skip: process.platform !== "darwin" && "chflags(uchg) is BSD/macOS-only; needed to force an EPERM on rmSync" },
  async () => {
    const dir = newDir();
    // Two prior imports so a third (with keepVersions: 1) has candidates
    // gcVersions will actually try to delete.
    await importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-19T03:00:00Z"),
      fetchImpl: serve(await buildFixtureZip()),
    });
    await importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-20T03:00:00Z"),
      fetchImpl: serve(await buildFixtureZip()),
    });

    // Make the oldest version's file immutable so rmSync throws EPERM when
    // gcVersions tries to remove it — rmSync's `force: true` only swallows
    // "does not exist" errors, not permission errors.
    const doomed = buildPathFor(dir, "2026-08-19T03-00-00-000Z");
    execSync(`chflags uchg ${JSON.stringify(doomed)}`);

    try {
      const r = await importFeed({
        url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
        fetchImpl: serve(await buildFixtureZip()),
        keepVersions: 1,
      });

      assert.equal(
        r.status, "imported",
        "the import must still succeed even though GC of an old version failed",
      );
      const live = resolveLive(dir);
      assert.ok(
        live && existsSync(live),
        "the just-published live database must survive a GC failure, not be deleted as if the build had failed",
      );
    } finally {
      execSync(`chflags nouchg ${JSON.stringify(doomed)}`);
    }
  },
);

test("propagates an unexpected HTML response as an error", async () => {
  const dir = newDir();
  const fetchImpl = (async () =>
    new Response("<html>blocked</html>", {
      status: 200, headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  await assert.rejects(
    importFeed({ url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"), fetchImpl }),
    /content-type/i,
  );
});

test("a thrown mid-stream failure leaves the previous database live and cleans up the partial build file", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  const before = resolveLive(dir);

  // csv-parse throws a genuine "Quote Not Closed" parser error (not a
  // per-row coercion failure caught by FeedWriter#writeRow) when a field
  // opens a quote it never closes. That exception surfaces from the
  // `for await (const row of csvRows(...))` loop itself, well after
  // openBuildDb/FeedWriter have created build-file state, so it exercises
  // importFeed's catch-and-cleanup path rather than the gate-rejection
  // path.
  //
  // A truncated zip body exercises the *source* side of the pipe instead
  // (see feed/zip.test.ts): `Readable.prototype.pipe` fails to propagate the
  // source's premature end, which is a property of `pipe`, not the zip
  // reader. This test instead uses a csv-parse error, which travels the
  // *destination* side of the pipe and is always catchable, so both
  // directions get their own coverage.
  const broken = {
    ...FIXTURE_FILES,
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id\n" +
      '"1,unterminated quote field\n',
  };

  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"),
      fetchImpl: serve(await buildFixtureZip(broken)),
    }),
    /quote/i,
  );

  assert.equal(resolveLive(dir), before, "live database must not have moved after a throw");
  // This throw happens mid-CSV-stream, well before finalizeForRead ever
  // switches the build db to WAL mode (openBuildDb uses journal_mode =
  // MEMORY throughout ingestion), so no -wal/-shm sidecars exist yet at
  // this point — this assertion only covers the main .sqlite file.
  // cleanupBuild's removal of -wal/-shm suffixes is real protection for a
  // throw in the narrower window between finalizeForRead's WAL switch and
  // db.close() (e.g. finalizeForRead itself throwing on a failed
  // checkpoint), which this particular scenario does not exercise.
  const leftovers = readdirSync(dir).filter(
    (f) => f.startsWith("gtfs-") && f.includes("2026-08-23"),
  );
  assert.deepEqual(leftovers, [], "no partial build file may survive a thrown failure");
});

// ---------------------------------------------------------------------------
// The stream error seam
// ---------------------------------------------------------------------------
//
// client.ts owns the response body, zip.ts pipes it, csv.ts pipes again, and
// this module owns the try/catch. No single task owned the path an error
// takes across all four, and it turned out no path existed: `pipe` does not
// forward source errors, so a socket dying mid-download emitted on a stream
// with no listener and killed the process before any of this module's
// cleanup could run.

/** A body that emits `head` and then fails the way a dying socket does. */
function dyingBody(head: Buffer, afterMs = 20): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(head);
          setTimeout(() => {
            const err = new Error("socket hang up") as Error & { code?: string };
            err.code = "ECONNRESET";
            c.error(err);
          }, afterMs);
        },
      }),
      { status: 200, headers: { "content-type": ZIP_TYPE } },
    )) as unknown as typeof fetch;
}

/** A body that emits `head` and then goes silent forever. */
function stallingBody(head: Buffer): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream({ start(c) { c.enqueue(head); } }),
      { status: 200, headers: { "content-type": ZIP_TYPE } },
    )) as unknown as typeof fetch;
}

test("a dying socket mid-download is a catchable failure, not a process-killing exception", async () => {
  const dir = newDir();
  const zip = await buildFixtureZip();

  // Before the fix this did not reject — it terminated the process with an
  // unhandled 'error' event, leaving the build database behind (up to 666 MB
  // against the real feed, on a service with no uncaughtException handler).
  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"),
      fetchImpl: dyingBody(zip.subarray(0, 512)),
    }),
    /socket hang up/,
  );

  assert.equal(resolveLive(dir), null, "nothing may have been published");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("gtfs-")), [],
    "the catch must have run and cleaned up the partial build",
  );
});

test("a mid-download failure leaves the previous database live and untouched", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  const before = resolveLive(dir);
  const zip = await buildFixtureZip();

  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"),
      fetchImpl: dyingBody(zip.subarray(0, 512)),
    }),
  );

  assert.equal(resolveLive(dir), before, "the live database must not have moved");
  assert.ok(existsSync(before!), "and must still exist on disk");
});

test("a truncated archive fails the run instead of stalling it", async () => {
  // A truncated archive is expected to fail outright, not stall: with
  // errors forwarded through the pipe, the archive reader reports
  // FILE_ENDED and this rejects.
  const dir = newDir();
  const zip = await buildFixtureZip();
  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"),
      fetchImpl: serve(zip.subarray(0, Math.floor(zip.length * 0.6))),
    }),
  );
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("gtfs-")), []);
});

test("a body that stops producing bytes is aborted by the stall timeout", async () => {
  const dir = newDir();
  const zip = await buildFixtureZip();

  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"),
      fetchImpl: stallingBody(zip.subarray(0, 512)),
      stallTimeoutMs: 200,
    }),
    /stalled: no bytes received/,
  );
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("gtfs-")), [],
    "an aborted stream must clean up like any other failure",
  );
});

test("the run-timeout backstop unwedges a stalled import even with no stall timeout in play", async () => {
  // Belt and braces, at the level an operator cares about: whatever the
  // cause, ImportRunner releases the single-flight lock so the next nightly
  // tick gets a real attempt. The stall timeout is set an order of magnitude
  // beyond the run timeout so it is provably not the mechanism doing the
  // work here (it is kept finite only so the abandoned run's timer does not
  // hold this test process open — in production that abandoned run keeps its
  // stall timer for the full configured window, which is the point).
  const dir = newDir();
  const zip = await buildFixtureZip();
  const runner = new ImportRunner(
    () =>
      importFeed({
        url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"),
        fetchImpl: stallingBody(zip.subarray(0, 512)),
        stallTimeoutMs: 3_000,
      }),
    { runTimeoutMs: 250 },
  );

  await assert.rejects(runner.run(), /did not complete within 250ms/);
  assert.equal(
    runner.isRunning(), false,
    "isRunning() must not stay true forever while /health reports 200",
  );
});

// ---------------------------------------------------------------------------
// Builds in progress are never mistaken for published versions
// ---------------------------------------------------------------------------

test("a build is written under a .building name and only takes its version name at publication", async () => {
  const dir = newDir();
  const version = "2026-08-21T03-00-00-000Z";
  const zip = await buildFixtureZip();

  // Observed from inside the download, which is the only place the claim can
  // actually be checked: a build that is cleaned up on failure looks
  // identical either way from the outside. Feeding the archive in two chunks
  // gives a window where the database exists and the run is still in flight.
  let midRun: string[] = [];
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        async start(c) {
          const half = Math.floor(zip.length / 2);
          c.enqueue(zip.subarray(0, half));
          await new Promise((r) => setTimeout(r, 40));
          midRun = readdirSync(dir).filter((f) => f.startsWith("gtfs-"));
          c.enqueue(zip.subarray(half));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": ZIP_TYPE } },
    )) as unknown as typeof fetch;

  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"), fetchImpl,
  });
  assert.equal(r.status, "imported");

  assert.ok(
    midRun.includes(`gtfs-${version}.sqlite.building`),
    `an in-progress build must carry the .building suffix; saw ${JSON.stringify(midRun)}`,
  );
  assert.equal(
    midRun.includes(`gtfs-${version}.sqlite`), false,
    "and must NOT occupy the published version name while it is still being written",
  );

  // Publication is the rename, and it is complete: no .building file lingers.
  assert.ok(existsSync(buildPathFor(dir, version)));
  assert.equal(existsSync(buildingPathFor(dir, version)), false);
});

test("an orphaned build from a killed run cannot evict a good rollback candidate", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-19T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  const rollbackTarget = buildPathFor(dir, "2026-08-19T03-00-00-000Z");

  // What a SIGTERM or an OOM mid-run leaves behind. Under the old naming
  // this was a plain gtfs-<version>.sqlite: it matched VERSION_RE, sorted
  // newest, consumed a retention slot, and pushed the only rollback
  // candidate out of the keep window.
  writeFileSync(buildingPathFor(dir, "2026-08-20T03-00-00-000Z"), "partial");

  const second = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
    keepVersions: 2,
  });
  assert.equal(second.status, "imported");
  assert.ok(
    existsSync(rollbackTarget),
    "the previous version must still be there to roll back to",
  );
});

test("a leftover build from a wedged run is swept at the start of the next one", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  const orphan = buildingPathFor(dir, "2026-08-20T03-00-00-000Z");
  writeFileSync(orphan, "partial");
  writeFileSync(`${orphan}-wal`, "wal");

  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  assert.equal(r.status, "imported");
  // Nothing else ever removes these: gcVersions correctly refuses to treat
  // them as versions, so without the sweep every crashed run leaks its
  // partial database (up to 666 MB) forever.
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(`${orphan}-wal`), false);
});

// ---------------------------------------------------------------------------
// readFeedMeta: the silent disabling of Gate 2
// ---------------------------------------------------------------------------

test("an unreadable live database is reported, not silently swallowed", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });

  // Corrupt the live database's target in place.
  writeFileSync(resolveLive(dir)!, "not a sqlite file at all");

  const warnings: string[] = [];
  const meta = readFeedMeta(dir, (m) => warnings.push(m));

  // The dangerous part is not the null itself but that it silently turns off
  // the count-ratio gate for the next run — precisely when a corrupt live
  // database means something is already wrong.
  assert.equal(meta.counts, null);
  assert.equal(warnings.length, 1, "the failure must produce exactly one warning");
  assert.match(warnings[0]!, /count-ratio sanity gate will not be applied/);
});

test("importFeed forwards the unreadable-live-database warning to its caller", async () => {
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  writeFileSync(resolveLive(dir)!, "not a sqlite file at all");

  const warnings: string[] = [];
  const r = await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-22T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(r.status, "imported");
  assert.equal(warnings.length, 1, "the run must not go quiet about a corrupt live database");
});

// ---------------------------------------------------------------------------
// Startup staleness
// ---------------------------------------------------------------------------

const HOUR = 60 * 60_000;
const fresh = (fetchedAt: string | null) => ({
  live: {
    version: "v", fetchedAt, sourceUrl: null, etag: null, lastModified: null,
    counts: null, badRows: null, path: "/tmp/x",
  },
  liveError: null,
});

test("startupImportReason: a missing live database still triggers a run", () => {
  assert.match(
    String(startupImportReason({ live: null, liveError: null }, new Date(), 26 * HOUR)),
    /no live database/,
  );
});

test("startupImportReason: an unreadable live database triggers a run", () => {
  assert.match(
    String(startupImportReason(
      { live: null, liveError: "unreadable: SQLITE_NOTADB" }, new Date(), 26 * HOUR,
    )),
    /unreadable/,
  );
});

test("startupImportReason: a stale live database triggers a run", () => {
  // Guards against a service that was down across its 03:00 window coming
  // back up and serving day-old data until the next night, reporting
  // healthy throughout.
  const now = new Date("2026-08-21T09:00:00Z");
  assert.match(
    String(startupImportReason(fresh("2026-08-19T03:00:00Z"), now, 26 * HOUR)),
    /staleness threshold/,
  );
});

test("startupImportReason: a fresh live database waits for the next cron", () => {
  const now = new Date("2026-08-21T09:00:00Z");
  assert.equal(startupImportReason(fresh("2026-08-21T03:00:00Z"), now, 26 * HOUR), null);
});

test("startupImportReason: an absent or unparseable fetch time counts as stale", () => {
  const now = new Date("2026-08-21T09:00:00Z");
  // Importing unnecessarily costs one wasted run; the opposite failure is
  // serving stale data indefinitely, so this errs toward importing.
  assert.match(String(startupImportReason(fresh(null), now, 26 * HOUR)), /no fetch time/);
  assert.match(
    String(startupImportReason(fresh("last tuesday"), now, 26 * HOUR)),
    /unparseable fetch time/,
  );
});

test("startupImportReason reads the real on-disk state of a just-published database", async () => {
  // Ties the pure helper to what readLiveState actually produces, so a
  // change to the persisted fetched_at format cannot leave the staleness
  // check quietly comparing against undefined.
  const dir = newDir();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: at("2026-08-21T03:00:00Z"),
    fetchImpl: serve(await buildFixtureZip()),
  });
  {
    const state = readLiveState(dir);
    assert.ok(state.live?.fetchedAt, "fetched_at must be persisted for staleness to work");
    assert.equal(
      startupImportReason(state, new Date("2026-08-21T04:00:00Z"), 26 * HOUR), null,
    );
    assert.match(
      String(startupImportReason(state, new Date("2026-08-25T04:00:00Z"), 26 * HOUR)),
      /staleness threshold/,
    );
  }
});

test("a failed run releases the response body's connection", async () => {
  // importFeed's catch is reachable mid-download, which makes the abandoned
  // body a live concern rather than a theoretical one. fetch/undici do not
  // release a body's connection when the Response is garbage collected, so
  // a run that fails partway through would leak a socket every night.
  //
  // The body here stays OPEN after delivering the archive, as a real
  // connection does while the server still has more to send: a stream that
  // has already closed itself cannot be cancelled, so only an open one can
  // show whether anything actually released it.
  const dir = newDir();
  const broken = {
    ...FIXTURE_FILES,
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id\n" +
      '"1,unterminated quote field\n',
  };
  const zip = await buildFixtureZip(broken);
  let cancelled = false;

  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        start(c) { c.enqueue(zip); /* deliberately never closed */ },
        cancel() { cancelled = true; },
      }),
      { status: 200, headers: { "content-type": ZIP_TYPE } },
    )) as unknown as typeof fetch;

  await assert.rejects(
    importFeed({
      url: "https://x/f.zip", dataDir: dir, now: at("2026-08-23T03:00:00Z"), fetchImpl,
    }),
    /quote/i,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(
    cancelled, true,
    "the underlying response stream must be cancelled, not left holding a socket",
  );
});

test("a run that fails before it starts reading still releases the connection", async () => {
  // The window between fetchFeed returning and the first byte being piped:
  // here a version collision aborts the run before the archive reader is
  // ever built, so nothing downstream exists to tear the body down. This is
  // the path that made the explicit destroy load-bearing rather than
  // redundant with zip.ts's pipeline.
  const dir = newDir();
  const clock = at("2026-08-21T03:00:00Z");
  const zip = await buildFixtureZip();
  await importFeed({
    url: "https://x/f.zip", dataDir: dir, now: clock, fetchImpl: serve(zip),
  });

  let cancelled = false;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        start(c) { c.enqueue(zip); /* deliberately never closed */ },
        cancel() { cancelled = true; },
      }),
      { status: 200, headers: { "content-type": ZIP_TYPE } },
    )) as unknown as typeof fetch;

  await assert.rejects(
    importFeed({ url: "https://x/f.zip", dataDir: dir, now: clock, fetchImpl }),
    /already exists/,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, true, "an unconsumed body must not be abandoned holding a socket");
});
