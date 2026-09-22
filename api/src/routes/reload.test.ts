import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { buildServer } from "../server.js";
import { RequestDrain } from "../requestDrain.js";

const V1 = "2026-08-21T16-10-22-006Z";
const V2 = "2026-08-22T00-00-00-000Z";

/**
 * A second fixture database: same schema as `buildFixtureDb`'s default, but
 * deliberately different in BOTH `feed_meta.version` (via the `version`
 * argument to `buildFixtureDb` itself) AND actual content (an agency name
 * changed here). Content, not just a version label, has to differ — otherwise
 * a passing assertion on the served agency name would not prove the SERVED
 * DATA changed, only that a string field happened to still match.
 */
function mutateSecondFixture(dir: string, version: string): void {
  const path = join(dir, `gtfs-${version}.sqlite`);
  const db = new Database(path);
  db.prepare("UPDATE agency SET agency_name = ?").run("רכבת חדשה");
  db.close();
}

test("a feed swap updates /meta's top-level version AND a browse endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-reload-"));
  buildFixtureDb(dir, V1);
  // A real RequestDrain here (not the default instantDrain) so this test also
  // exercises the onRequest/onResponse-driven "close only after drained"
  // path a live server actually uses, not just the fallback tests otherwise
  // implicitly rely on.
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    buildFn: async () => buildIndex(join(dir, "gtfs.sqlite")),
    drain,
  });
  await index.rebuild();
  const app = await buildServer({ index, drain });

  const before = (await app.inject({ url: "/meta" })).json() as { version: string };
  assert.equal(before.version, V1);
  const beforeAgencies = (await app.inject({ url: "/agencies" })).json() as
    { agencies: { name: string | null }[] };
  assert.equal(beforeAgencies.agencies[0]!.name, "רכבת ישראל");

  // Publish a second version with a different feed_meta.version AND
  // different content, and repoint the live symlink at it -- exactly what
  // gtfs does on a nightly import. `buildFixtureDb` itself creates
  // the `gtfs.sqlite` symlink, so the existing one (pointed at V1) must be
  // removed first or its own `symlinkSync` call throws EEXIST.
  unlinkSync(join(dir, "gtfs.sqlite"));
  buildFixtureDb(dir, V2);
  mutateSecondFixture(dir, V2);

  assert.equal(await index.maybeReload(), true);

  // /meta's top-level version must be read fresh from the current index on
  // every request, not captured once at boot -- index.version (not asserted
  // here) already tracks the swap, and /meta must not lag behind it.
  const after = (await app.inject({ url: "/meta" })).json() as { version: string };
  assert.equal(after.version, V2, "top-level /meta version must reflect the swapped feed");

  const afterAgencies = (await app.inject({ url: "/agencies" })).json() as
    { agencies: { name: string | null }[] };
  assert.equal(
    afterAgencies.agencies[0]!.name, "רכבת חדשה",
    "a browse endpoint must serve the new database's content after a swap, not the one open at boot",
  );

  await app.close(); index.stop();
});

test("a failed index rebuild leaves the previous database (and /meta's version) serving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-reload-fail-"));
  buildFixtureDb(dir, V1);
  let calls = 0;
  const index = new IndexManager(dir, {
    buildFn: async () => {
      calls++;
      if (calls > 1) throw new Error("boom");
      return buildIndex(join(dir, "gtfs.sqlite"));
    },
  });
  await index.rebuild();
  const app = await buildServer({ index });

  unlinkSync(join(dir, "gtfs.sqlite"));
  buildFixtureDb(dir, V2);
  mutateSecondFixture(dir, V2);

  await assert.rejects(index.rebuild(), /boom/);

  const meta = (await app.inject({ url: "/meta" })).json() as { version: string };
  assert.equal(meta.version, V1, "a failed rebuild must not swap the database either");
  const agencies = (await app.inject({ url: "/agencies" })).json() as
    { agencies: { name: string | null }[] };
  assert.equal(agencies.agencies[0]!.name, "רכבת ישראל");

  await app.close(); index.stop();
});
