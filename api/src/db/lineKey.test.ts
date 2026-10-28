import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { LINE_KEY_SQL } from "./lines.js";
import { lineDirectionOf, lineKeyOf } from "./lineKey.js";

test("a bus row's line is its ministry code, its direction the desc's digit", () => {
  assert.equal(lineKeyOf("R1", "67001-1-#"), "67001");
  assert.equal(lineDirectionOf("67001-1-#"), "1");
  assert.equal(lineKeyOf("R5", "67003-2-0"), "67003");
  assert.equal(lineDirectionOf("67003-2-0"), "2");
});

/** Rail rows share bare descs across different services, so a rail line is
 *  keyed on its route id -- see `LINE_KEY_SQL`. */
test("a rail row, or a row with no desc, is a line of its own with one direction", () => {
  assert.equal(lineKeyOf("R7", "900"), "route:R7");
  assert.equal(lineDirectionOf("900"), "1");
  assert.equal(lineKeyOf("RX", null), "route:RX");
  assert.equal(lineDirectionOf(null), "1");
});

test("lineKeyOf agrees with LINE_KEY_SQL on every fixture route", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-linekey-"));
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  const rows = h.db.prepare(
    `SELECT route_id, route_desc, ${LINE_KEY_SQL} AS key FROM routes`,
  ).all() as { route_id: string; route_desc: string | null; key: string }[];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(lineKeyOf(row.route_id, row.route_desc), row.key, row.route_id);
  }
  h.close();
});
