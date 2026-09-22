import { test } from "node:test";
import assert from "node:assert/strict";
import { runIdFor } from "./unscheduledRuns.js";
import type { UnscheduledRun } from "../realtime/match.js";

function run(vehicleRef: string | null, offsetSeconds = -300): UnscheduledRun {
  return {
    templateTripIdx: 0, offsetSeconds, serviceBaseEpoch: 0, byStopIdx: new Map(),
    journey: {
      lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
      originAimedDeparture: null, operatorRef: null, publishedLineName: null, vehicleRef,
      confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
    },
  };
}

test("an unscheduled run is identified by its template trip and its vehicle", () => {
  assert.equal(runIdFor("T1", run("veh-9"), new Set()), "T1@veh-9");
});

test("with no vehicle ref, the start offset stands in for it", () => {
  assert.equal(runIdFor("T1", run(null, -300), new Set()), "T1@-300");
});

test("a repeated id is suffixed in order, so every row key is unique", () => {
  const taken = new Set<string>();
  assert.deepEqual(
    [runIdFor("T1", run(null), taken), runIdFor("T1", run(null), taken), runIdFor("T1", run(null), taken)],
    ["T1@-300", "T1@-300#2", "T1@-300#3"],
  );
});
