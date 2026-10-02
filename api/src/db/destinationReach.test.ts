import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { destinationReach, reachKey } from "./destinationReach.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-reach-"));
  buildFixtureDb(dir);
  return openTransitDb(dir);
}

// From stop 1000, T101 (R3) runs 1000 -> 2000 -> 4000 and T105 (R7, rail)
// runs 1000 -> 4000. T1/T2/T102 all terminate at 2000 and must not appear.
test("keeps only the runs that call at the destination after boarding", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T1", "T2", "T101", "T102", "T105"],
    boardStopIds: ["1000"],
    destStops: [{ stopId: "4000", walkMeters: 0 }],
  });
  assert.deepEqual(
    [...reach.keys()].sort(),
    [reachKey("T101", 1), reachKey("T105", 1)].sort(),
  );
  h.close();
});

// 43200 (12:00) at stop 1000 to 44400 (12:20) at stop 4000.
test("reports the destination stop and the scheduled seconds on board", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T101"], boardStopIds: ["1000"], destStops: [{ stopId: "4000", walkMeters: 0 }],
  });
  assert.deepEqual(reach.get(reachKey("T101", 1)), {
    stopId: "4000", stopSequence: 3, rideSeconds: 1200, walkMeters: 0,
  });
  h.close();
});

// The rider named a place; several stops around it are candidates, and the
// run calls at only one of them.
test("reports whichever of the nearby stops the run actually calls at", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T101"], boardStopIds: ["1000"],
    destStops: [{ stopId: "3000", walkMeters: 40 }, { stopId: "4000", walkMeters: 90 }],
  });
  const hit = reach.get(reachKey("T101", 1));
  assert.equal(hit?.stopId, "4000");
  assert.equal(hit?.walkMeters, 90);
  h.close();
});

// Riding one stop further to arrive at the door beats hopping off where the
// route first clips the edge of the area. T101 calls at 2000 (seq 2) then
// 4000 (seq 3); the second is much closer to the place named.
test("rides past a far stop in the area to reach a nearer one", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T101"], boardStopIds: ["1000"],
    destStops: [{ stopId: "2000", walkMeters: 470 }, { stopId: "4000", walkMeters: 60 }],
  });
  const hit = reach.get(reachKey("T101", 1));
  assert.equal(hit?.stopId, "4000");
  assert.equal(hit?.stopSequence, 3);
  assert.equal(hit?.walkMeters, 60);
  h.close();
});

// Equally far: get off at the first chance rather than ride on for nothing.
test("settles an equal walk by getting off earlier", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T101"], boardStopIds: ["1000"],
    destStops: [{ stopId: "2000", walkMeters: 200 }, { stopId: "4000", walkMeters: 200 }],
  });
  assert.equal(reach.get(reachKey("T101", 1))?.stopId, "2000");
  h.close();
});

// The destination BEFORE the boarding stop is not a destination: T103 runs
// 4000 -> 1000, so boarding it at 1000 never reaches 4000.
test("ignores a call at the destination earlier in the run", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T103"], boardStopIds: ["1000"], destStops: [{ stopId: "4000", walkMeters: 0 }],
  });
  assert.equal(reach.size, 0);
  h.close();
});

// A trip's last stop carries pickup_type=1: you cannot board there, so it is
// not a boarding that reaches anything -- and T3 boards at 2000, not 1000.
test("is empty when no listed trip boards at the board's stops", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T3"], boardStopIds: ["1000"], destStops: [{ stopId: "4000", walkMeters: 0 }],
  });
  assert.equal(reach.size, 0);
  h.close();
});

// Crossing midnight: T3 boards at 2000 at 91800 (25:30) and calls at 4000 at
// 92400 (25:40). Seconds-since-service-midnight subtract cleanly; clock
// times would not.
test("measures the ride across a past-midnight service day", () => {
  const h = fixture();
  const reach = destinationReach(h.db, {
    tripIds: ["T3"], boardStopIds: ["2000"], destStops: [{ stopId: "4000", walkMeters: 0 }],
  });
  assert.equal(reach.get(reachKey("T3", 1))?.rideSeconds, 600);
  h.close();
});

test("returns nothing for an empty trip list without touching the db", () => {
  const h = fixture();
  assert.equal(destinationReach(h.db, {
    tripIds: [], boardStopIds: ["1000"], destStops: [{ stopId: "4000", walkMeters: 0 }],
  }).size, 0);
  h.close();
});
