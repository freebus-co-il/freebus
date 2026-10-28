import { test } from "node:test";
import assert from "node:assert/strict";
import { TABLE_SPECS, SKIPPED_FILES, specForFile } from "./tables.js";
import { FIXTURE_FILES } from "../testing/fixture.js";

/** Headers that are intentionally not mapped to columns. */
const UNMAPPED_HEADERS: Record<string, string[]> = {
  // Add any intentionally unmapped headers here. The point is to make
  // skipping a column a deliberate, visible act rather than an oversight.
};

test("covers every feed file exactly once", () => {
  const handled = [...TABLE_SPECS.map((s) => s.file), ...SKIPPED_FILES].sort();
  assert.deepEqual(handled, [
    "agency.txt", "calendar.txt", "fare_attributes.txt", "fare_rules.txt",
    "routes.txt", "shapes.txt", "stop_times.txt", "stops.txt",
    "translations.txt", "trips.txt",
  ]);
});

test("fare files are skipped", () => {
  assert.deepEqual([...SKIPPED_FILES].sort(), ["fare_attributes.txt", "fare_rules.txt"]);
});

test("every declared header exists in the fixture, which mirrors the real feed", () => {
  for (const spec of TABLE_SPECS) {
    if (spec.file === "shapes.txt") continue; // handled by the shape accumulator
    const header = FIXTURE_FILES[spec.file]!.split("\n")[0]!.split(",");
    for (const col of spec.columns) {
      assert.ok(
        header.includes(col.header),
        `${spec.file}: declared header "${col.header}" not in feed`,
      );
    }
  }
});

test("every fixture header is either claimed by a ColumnSpec or listed as intentionally unmapped", () => {
  for (const spec of TABLE_SPECS) {
    const headers = FIXTURE_FILES[spec.file]!.split("\n")[0]!.split(",");
    const claimed = new Set(spec.columns.map((c) => c.header));
    const unmapped = new Set(UNMAPPED_HEADERS[spec.file] ?? []);

    for (const header of headers) {
      const isClaimed = claimed.has(header);
      const isUnmapped = unmapped.has(header);
      assert.ok(
        isClaimed || isUnmapped,
        `${spec.file}: header "${header}" is neither claimed by a ColumnSpec nor listed in UNMAPPED_HEADERS`,
      );
    }

    // Also check that all unmapped headers actually exist in the fixture.
    for (const header of unmapped) {
      assert.ok(
        headers.includes(header),
        `${spec.file}: UNMAPPED_HEADERS lists "${header}" but it doesn't exist in the fixture`,
      );
    }
  }
});

test("routes does not reference route_text_color", () => {
  const spec = specForFile("routes.txt")!;
  assert.ok(!spec.columns.some((c) => c.header === "route_text_color"));
});

test("coercion turns a stop_times row into typed values", () => {
  const spec = specForFile("stop_times.txt")!;
  const row = {
    trip_id: "T2", arrival_time: "25:30:00", departure_time: "25:30:00",
    stop_id: "1", stop_sequence: "1", pickup_type: "0",
    drop_off_type: "0", shape_dist_traveled: "",
  };
  const byCol = Object.fromEntries(
    spec.columns.map((c) => [c.column, c.coerce(row[c.header as keyof typeof row] ?? "")]),
  );
  assert.equal(byCol.arrival_time, 91800);
  assert.equal(byCol.shape_dist_traveled, null);
  assert.equal(byCol.stop_sequence, 1);
});
