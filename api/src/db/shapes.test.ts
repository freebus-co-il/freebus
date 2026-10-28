import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { legShapeRefs, shapePolyline } from "./shapes.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-shapes-"));
  buildFixtureDb(dir);
  return openTransitDb(dir);
}

test("legShapeRefs resolves a trip's shape and its endpoint distances", () => {
  const h = fixture();
  const refs = legShapeRefs(h.db, "T1", 0, 1);
  assert.ok(refs);
  assert.equal(refs.shapeId, "SH1");
  assert.equal(refs.fromDist, 0);
  assert.equal(refs.toDist, 1200);
  // Stop coordinates come back for the projection fallback.
  assert.ok(refs.fromStop);
  assert.ok(refs.toStop);
  assert.ok(Math.abs(refs.fromStop[0] - 32.0554) < 1e-9);
  assert.ok(Math.abs(refs.toStop[0] - 32.0600) < 1e-9);
  h.close();
});

// 1,085 real trips carry no shape_id. The caller must be able to tell.
test("legShapeRefs reports a null shapeId for a shapeless trip", () => {
  const h = fixture();
  const refs = legShapeRefs(h.db, "T3", 0, 1);
  assert.ok(refs);
  assert.equal(refs.shapeId, null);
  h.close();
});

test("legShapeRefs returns null for an unknown trip", () => {
  const h = fixture();
  assert.equal(legShapeRefs(h.db, "nope", 0, 1), null);
  h.close();
});

test("legShapeRefs returns null when a position is out of range", () => {
  const h = fixture();
  assert.equal(legShapeRefs(h.db, "T1", 0, 99), null);
  h.close();
});

test("shapePolyline returns the encoded shape, and null when absent", () => {
  const h = fixture();
  const p = shapePolyline(h.db, "SH1");
  assert.ok(p && p.length > 0);
  assert.equal(shapePolyline(h.db, "nope"), null);
  h.close();
});

// `stops.stop_lat`/`stop_lon` are nullable in the schema. Defaulting a missing
// one to `[0, 0]` would project the stop into the Gulf of Guinea rather than
// admitting it cannot be projected at all.
test("legShapeRefs reports a null coordinate rather than inventing [0, 0]", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-shapes-nullcoord-"));
  const link = buildFixtureDb(dir);
  const rw = new Database(link);
  rw.exec("UPDATE stops SET stop_lat = NULL, stop_lon = NULL WHERE stop_id = '2000'");
  rw.close();

  const h = openTransitDb(dir);
  const refs = legShapeRefs(h.db, "T1", 0, 1);
  assert.ok(refs);
  assert.ok(refs.fromStop);
  assert.equal(refs.toStop, null);
  h.close();
});
