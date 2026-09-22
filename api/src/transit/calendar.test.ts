import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "../db/connect.js";
import {
  loadCalendar, serviceWindow, activeServiceIds,
  serviceInstants, toEpochSeconds, toIso, ymdOf,
} from "./calendar.js";

const TZ = "Asia/Jerusalem";

function rows() {
  const dir = mkdtempSync(join(tmpdir(), "transit-cal-"));
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  const r = loadCalendar(h.db);
  h.close();
  return r;
}

test("loads the calendar with a Sunday-first day bitmask", () => {
  const r = rows();
  const s1 = r.find((x) => x.serviceId === "S1")!;
  // S1 runs Sunday..Thursday: bits 0-4 set, bits 5-6 clear.
  assert.equal(s1.days, 0b0011111);
  const s2 = r.find((x) => x.serviceId === "S2")!;
  // S2 runs Friday and Saturday: bits 5-6.
  assert.equal(s2.days, 0b1100000);
});

test("serviceWindow spans the calendar", () => {
  assert.deepEqual(serviceWindow(rows()), { start: 20260821, end: 20260920 });
});

test("activeServiceIds picks the right services for a weekday", () => {
  // 2026-08-24 is a Monday.
  assert.deepEqual([...activeServiceIds(rows(), 20260824)], ["S1"]);
  // 2026-08-22 is a Saturday.
  assert.deepEqual([...activeServiceIds(rows(), 20260822)], ["S2"]);
});

test("a date outside the calendar window yields no services", () => {
  assert.equal(activeServiceIds(rows(), 20261101).size, 0);
});

// The core midnight rule: at 00:30 the previous service day is still running.
test("serviceInstants returns today and yesterday, yesterday past 86400", () => {
  const at = new Date("2026-08-24T00:30:00+03:00");
  const [today, yesterday] = serviceInstants(at, TZ);
  assert.equal(today!.dateYmd, 20260824);
  assert.equal(today!.secondsSinceMidnight, 1800);
  assert.equal(yesterday!.dateYmd, 20260823);
  assert.equal(yesterday!.secondsSinceMidnight, 88200);
});

test("toEpochSeconds round-trips a past-midnight time to the right wall clock", () => {
  const at = new Date("2026-08-24T00:30:00+03:00");
  const [, yesterday] = serviceInstants(at, TZ);
  // 25:30 on the 23rd is 01:30 on the 24th.
  const iso = toIso(toEpochSeconds(yesterday!, 91800), TZ);
  assert.match(iso, /^2026-08-24T01:30:00/);
});

test("ymdOf reads the local date, not UTC", () => {
  // 22:30 UTC on the 23rd is 01:30 local on the 24th.
  assert.equal(ymdOf(new Date("2026-08-23T22:30:00Z"), TZ), 20260824);
});

test("activeServiceIds is inclusive at the start_date boundary", () => {
  // 2026-08-21 (the calendar's start_date) is a Friday: S2 runs, S1 doesn't.
  assert.deepEqual([...activeServiceIds(rows(), 20260821)], ["S2"]);
});

test("activeServiceIds is inclusive at the end_date boundary", () => {
  // 2026-09-20 (the calendar's end_date) is a Sunday: S1 runs, S2 doesn't.
  assert.deepEqual([...activeServiceIds(rows(), 20260920)], ["S1"]);
});

// Israel's spring-forward transition in 2026 is 2026-03-27 at 02:00 -> 03:00.
// Without the noon-based origin, a query just after local midnight would
// compute yesterday's baseEpoch as exactly 86400s earlier — it's actually
// 82800s (23h), because the wall clock skipped an hour overnight. A
// hardcoded 86400 gap, or `baseEpochOf` reverting to `startOf('day')`, must
// fail this test.
test("previous-day gap is 23h (82800s), not 86400s, across spring-forward", () => {
  const at = new Date("2026-03-27T00:30:00+02:00");
  const [today, yesterday] = serviceInstants(at, TZ);
  assert.equal(today!.dateYmd, 20260327);
  assert.equal(yesterday!.dateYmd, 20260326);
  assert.equal(today!.baseEpoch - yesterday!.baseEpoch, 82800);
});

// Israel's fall-back transition in 2026 is 2026-10-25 at 03:00 -> 02:00.
// The previous-day gap is 25h (90000s), not 86400s, for the same reason in
// reverse: the wall clock repeated an hour overnight.
test("previous-day gap is 25h (90000s), not 86400s, across fall-back", () => {
  const at = new Date("2026-10-25T00:30:00+03:00");
  const [today, yesterday] = serviceInstants(at, TZ);
  assert.equal(today!.dateYmd, 20261025);
  assert.equal(yesterday!.dateYmd, 20261024);
  assert.equal(today!.baseEpoch - yesterday!.baseEpoch, 90000);
});

// Pins the noon-based origin's actual wall-clock behaviour on the
// spring-forward day. If `baseEpochOf` were reverted to `startOf('day')`,
// this would resolve to a different local time (verified by direct
// computation: midnight-based gives 2026-03-27T03:00:00+03:00 for the same
// gtfsSeconds, one hour later than the noon-based result asserted here).
test("noon-based origin yields the spec-correct wall clock on spring-forward day", () => {
  const at = new Date("2026-03-27T00:30:00+02:00");
  const [today] = serviceInstants(at, TZ);
  const iso = toIso(toEpochSeconds(today!, 7200), TZ);
  assert.equal(iso, "2026-03-27T01:00:00+02:00");
});

// Same pin on the fall-back day. Midnight-based arithmetic would instead
// resolve gtfsSeconds=7200 to 2026-10-25T01:00:00+02:00, one hour earlier.
test("noon-based origin yields the spec-correct wall clock on fall-back day", () => {
  const at = new Date("2026-10-25T00:30:00+03:00");
  const [today] = serviceInstants(at, TZ);
  const iso = toIso(toEpochSeconds(today!, 7200), TZ);
  assert.equal(iso, "2026-10-25T02:00:00+02:00");
});

// On the fall-back day, a query shortly after local midnight falls *before*
// the noon-based origin (which sits at 01:00 that day, because noon-12h
// landed inside the repeated hour) — so secondsSinceMidnight is legitimately
// negative. This is the noon-based design working as specified, not a bug;
// pinned here so nobody "fixes" it with a clamp to zero.
test("secondsSinceMidnight can be negative just after midnight on fall-back day", () => {
  const at = new Date("2026-10-25T00:30:00+03:00");
  const [today] = serviceInstants(at, TZ);
  assert.equal(today!.dateYmd, 20261025);
  assert.equal(today!.secondsSinceMidnight, -1800);
});
