import { test } from "node:test";
import assert from "node:assert/strict";
import type { Itinerary, Leg, Place } from "./itinerary.js";
import { journeyCost, hasTransitLeg, walkShareWithin, journeyKey, rankItineraries, type RankConfig } from "./rank.js";

export const CFG: RankConfig = {
  walkWeight: 2,
  transferPenaltySeconds: 300,
  departureWindowSeconds: 1800,
  maxWalkShare: 0.7,
};

const PLACE: Place = { type: "stop", lat: 32.47, lon: 34.95 };

/** A walk leg of `seconds`. Distance is irrelevant to every function under
 *  test, so it mirrors the duration rather than inventing a second number. */
export function walk(seconds: number): Leg {
  return {
    type: "walk", from: PLACE, to: PLACE,
    distanceMeters: seconds, durationSeconds: seconds,
    geometry: null, walkEstimated: true,
  };
}

/** A transit leg. Only `tripId` and the two `stopSequence`s matter to the
 *  functions under test -- they are what `journeyKey` reads. */
export function ride(tripId: string, fromSeq = 1, toSeq = 5): Leg {
  return {
    type: "transit",
    route: { id: "r1", agencyId: null, shortName: "34", longName: null, type: 3, color: null },
    tripId, headsign: null, tripNumber: null, directionId: 0,
    from: { stop: PLACE, departureTime: "2026-08-25T11:39:00+03:00",
            scheduledDepartureTime: "2026-08-25T11:39:00+03:00", stopSequence: fromSeq },
    to: { stop: PLACE, arrivalTime: "2026-08-25T11:48:00+03:00",
          scheduledArrivalTime: "2026-08-25T11:48:00+03:00", stopSequence: toSeq },
    numStops: toSeq - fromSeq, intermediateStops: [],
    geometry: null, geometryFallback: true, realtime: null,
    alternatives: [],
  };
}

/** An itinerary with only the fields the ranking reads set meaningfully. */
export function itin(o: {
  departureTime?: string; durationSeconds: number; walkSeconds: number;
  transfers?: number; legs?: Leg[];
}): Itinerary {
  return {
    departureTime: o.departureTime ?? "2026-08-25T11:16:00+03:00",
    arrivalTime: "2026-08-25T11:36:00+03:00",
    durationSeconds: o.durationSeconds,
    transfers: o.transfers ?? 0,
    walkSeconds: o.walkSeconds,
    walkMeters: o.walkSeconds,
    legs: o.legs ?? [walk(o.walkSeconds), ride("t1")],
    transferAtRisk: null,
  };
}

// These three numbers are the whole
// point of the feature: the walk-heavy journey the planner returns today must
// cost more than twice what bus 34 costs.
test("journeyCost matches the worked walking-cost example", () => {
  const walkHeavy = itin({ durationSeconds: 1200, walkSeconds: 1020, transfers: 0 });
  const bus34 = itin({ durationSeconds: 720, walkSeconds: 180, transfers: 0 });
  const twoBus = itin({ durationSeconds: 1020, walkSeconds: 840, transfers: 1 });

  assert.equal(journeyCost(walkHeavy, CFG), 2220);
  assert.equal(journeyCost(bus34, CFG), 900);
  assert.equal(journeyCost(twoBus, CFG), 2160);
});

test("journeyCost at walkWeight 1 with no transfer penalty is duration", () => {
  const flat: RankConfig = { ...CFG, walkWeight: 1, transferPenaltySeconds: 0 };
  const j = itin({ durationSeconds: 1200, walkSeconds: 1020, transfers: 2 });
  assert.equal(journeyCost(j, flat), 1200);
});

// Round 0's access labels plus footpath relaxation can
// reach the destination with no boarding at all, producing an itinerary of
// pure walking that reports `transfers: 0`.
test("hasTransitLeg rejects a walk-only itinerary", () => {
  const walkOnly = itin({
    durationSeconds: 1320, walkSeconds: 1320,
    legs: [walk(440), walk(660), walk(220)],
  });
  assert.equal(hasTransitLeg(walkOnly), false);
});

test("hasTransitLeg keeps an itinerary with any transit leg", () => {
  const withBus = itin({
    durationSeconds: 720, walkSeconds: 180,
    legs: [walk(120), ride("t1"), walk(60)],
  });
  assert.equal(hasTransitLeg(withBus), true);
});

// The cap is fixed at 0.7 deliberately: a widely-used transit app's own second
// result for the reference query is 14 minutes of walking on a 17-minute trip
// (82%), so a 50% cap would delete a journey that app is happy to show.
// This asserts the boundary in both directions so the threshold cannot be
// tightened without a test failing.
test("walkShareWithin keeps 82% walking only above the default cap", () => {
  const heavy = itin({ durationSeconds: 1020, walkSeconds: 840 });
  assert.equal(walkShareWithin(heavy, CFG), false);
  assert.equal(walkShareWithin(heavy, { ...CFG, maxWalkShare: 0.9 }), true);
});

test("walkShareWithin is inclusive at exactly the cap", () => {
  const exact = itin({ durationSeconds: 1000, walkSeconds: 700 });
  assert.equal(walkShareWithin(exact, CFG), true);
});

test("walkShareWithin keeps a zero-duration itinerary rather than dividing", () => {
  const degenerate = itin({ durationSeconds: 0, walkSeconds: 0 });
  assert.equal(walkShareWithin(degenerate, CFG), true);
});

// The forward and reverse searches will frequently
// reconstruct the same ride. Identity is the transit legs only -- the access
// and egress walks are derived from the same origin/destination either way
// and say nothing about which ride this is.
test("journeyKey is equal for the same rides reached by different searches", () => {
  const a = itin({
    durationSeconds: 720, walkSeconds: 180,
    legs: [walk(120), ride("trip-A", 3, 9), walk(60)],
  });
  const b = itin({
    durationSeconds: 780, walkSeconds: 240,
    legs: [walk(180), ride("trip-A", 3, 9), walk(60)],
  });
  assert.equal(journeyKey(a), journeyKey(b));
});

test("journeyKey separates different boarding points on the same trip", () => {
  const early = itin({ durationSeconds: 720, walkSeconds: 180, legs: [ride("trip-A", 3, 9)] });
  const late = itin({ durationSeconds: 600, walkSeconds: 180, legs: [ride("trip-A", 5, 9)] });
  assert.notEqual(journeyKey(early), journeyKey(late));
});

test("journeyKey separates a two-ride journey from a one-ride journey", () => {
  const one = itin({ durationSeconds: 720, walkSeconds: 60, legs: [ride("trip-A", 1, 5)] });
  const two = itin({
    durationSeconds: 720, walkSeconds: 60, transfers: 1,
    legs: [ride("trip-A", 1, 5), walk(90), ride("trip-B", 2, 7)],
  });
  assert.notEqual(journeyKey(one), journeyKey(two));
});

const ID = (i: Itinerary): Itinerary => i;

test("rankItineraries puts the low-effort later departure first", () => {
  const walkHeavy = itin({
    departureTime: "2026-08-25T11:16:00+03:00",
    durationSeconds: 1200, walkSeconds: 400,
    legs: [walk(200), ride("t-walkheavy"), walk(200)],
  });
  const bus34 = itin({
    departureTime: "2026-08-25T11:39:00+03:00",
    durationSeconds: 720, walkSeconds: 180,
    legs: [walk(120), ride("t-bus34"), walk(60)],
  });

  const ranked = rankItineraries([walkHeavy, bus34], ID, CFG);
  assert.equal(ranked.length, 2);
  assert.equal(journeyKey(ranked[0]!), journeyKey(bus34));
});

test("rankItineraries drops walk-only and over-cap candidates", () => {
  const walkOnly = itin({
    durationSeconds: 1320, walkSeconds: 1320, legs: [walk(660), walk(660)],
  });
  const overCap = itin({
    durationSeconds: 1020, walkSeconds: 840, legs: [walk(420), ride("t-x"), walk(420)],
  });
  const good = itin({
    durationSeconds: 720, walkSeconds: 180, legs: [walk(120), ride("t-good"), walk(60)],
  });

  const ranked = rankItineraries([walkOnly, overCap, good], ID, CFG);
  assert.equal(ranked.length, 1);
  assert.equal(journeyKey(ranked[0]!), journeyKey(good));
});

test("rankItineraries applies no filters when told not to", () => {
  const walkOnly = itin({
    durationSeconds: 1320, walkSeconds: 1320, legs: [walk(660), walk(660)],
  });
  const ranked = rankItineraries([walkOnly], ID, CFG, { applyFilters: false });
  assert.equal(ranked.length, 1);
});

// The tie rule: same ride, keep the later departure.
test("rankItineraries collapses duplicates and keeps the later departure", () => {
  const early = itin({
    departureTime: "2026-08-25T11:20:00+03:00",
    durationSeconds: 900, walkSeconds: 180,
    legs: [walk(120), ride("trip-A", 3, 9), walk(60)],
  });
  const late = itin({
    departureTime: "2026-08-25T11:31:00+03:00",
    durationSeconds: 720, walkSeconds: 180,
    legs: [walk(120), ride("trip-A", 3, 9), walk(60)],
  });

  const ranked = rankItineraries([early, late], ID, CFG);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.departureTime, "2026-08-25T11:31:00+03:00");
});

// The anchor is the EARLIEST SURVIVING DEPARTURE, not the
// query instant -- so a cheap journey more than W past the first real option
// is listed but can never outrank one inside the window.
test("rankItineraries never promotes a journey past the window", () => {
  const inWindow = itin({
    departureTime: "2026-08-25T11:20:00+03:00",
    durationSeconds: 1500, walkSeconds: 300,
    legs: [walk(150), ride("t-in"), walk(150)],
  });
  const cheapButLate = itin({
    departureTime: "2026-08-25T12:30:00+03:00",
    durationSeconds: 300, walkSeconds: 60,
    legs: [walk(30), ride("t-late"), walk(30)],
  });

  const ranked = rankItineraries([cheapButLate, inWindow], ID, CFG);
  assert.equal(ranked.length, 2);
  assert.equal(journeyKey(ranked[0]!), journeyKey(inWindow));
  assert.equal(journeyKey(ranked[1]!), journeyKey(cheapButLate));
});

// The exemption, and the arithmetic that forces it. The two
// bounds in play are anchored on DIFFERENT quantities:
//
//   probe generation (routes/plan.ts): arrival <= A_min + W
//   ranking window   (this file):      departure <= D_forward + W
//
// with A_min = D_forward + dur_forward. A probe candidate departs at
// A_probe - dur_probe <= A_min + W - dur_probe, and the cutoff is
// A_min - dur_forward + W, so it can clear the cutoff ONLY WHEN
// dur_probe >= dur_forward -- only when what the probe found is no faster than
// the forward answer. The probe exists to find FASTER, lower-effort journeys,
// so the window unexempted demotes exactly its success case.
//
// The numbers below are that case, made concrete (seconds-of-day on
// 2026-08-25, +03:00):
//
//   forward: departs 40560 (11:16), duration 2400, walk 1500
//            walk share 62.5%, UNDER the 0.7 cap -- so it survives and
//            anchors the window at its own early departure. That is what the
//            reference query's 85%-walking forward answer does NOT do: the cap
//            deletes it, moving the anchor onto the probe. This test is the
//            case where that accidental rescue does not happen.
//            arrival 42960 (11:56) = A_min; cost 2400 + 1500 = 3900.
//   probe:   deadline A_min + 1800 = 44760 (12:26). Departs 43800 (12:10),
//            duration 900, walk 120 -> arrives 44700, legitimately inside the
//            probe's own bound. Cost 900 + 120 = 1020.
//
// Ranking cutoff is 40560 + 1800 = 42360 (11:46), and 43800 > 42360. Without
// the exemption the 3.8x cheaper journey is ranked SECOND by construction.
test("rankItineraries ranks an exempt probe candidate on cost, not on the window", () => {
  const forward = {
    itinerary: itin({
      departureTime: "2026-08-25T11:16:00+03:00",
      durationSeconds: 2400, walkSeconds: 1500,
      legs: [walk(750), ride("t-forward"), walk(750)],
    }),
    probe: false,
  };
  const probe = {
    itinerary: itin({
      departureTime: "2026-08-25T12:10:00+03:00",
      durationSeconds: 900, walkSeconds: 120,
      legs: [walk(60), ride("t-probe"), walk(60)],
    }),
    probe: true,
  };

  // The premises, asserted rather than assumed: if either of these stops
  // holding the test below stops testing what it claims to.
  assert.equal(walkShareWithin(forward.itinerary, CFG), true,
    "the forward candidate must survive the cap to anchor the window early");
  assert.equal(journeyCost(forward.itinerary, CFG), 3900);
  assert.equal(journeyCost(probe.itinerary, CFG), 1020);

  const ranked = rankItineraries(
    [forward, probe], (c) => c.itinerary, CFG, { exempt: (c) => c.probe },
  );
  assert.deepEqual(ranked.map((c) => c.probe), [true, false]);

  // ... and the same input with no exemption is the defect, kept here so the
  // exemption cannot be deleted without a test explaining what it was for.
  const unexempt = rankItineraries([forward, probe], (c) => c.itinerary, CFG);
  assert.deepEqual(unexempt.map((c) => c.probe), [false, true]);
});

// The exemption must not break the anchor when the filters delete every
// non-exempt candidate -- the sparse-case floor. Here the forward answer is
// 85% walking (the reference query's own shape) and the cap drops it, leaving
// only the probe. A naive implementation that anchors over non-exempt
// candidates and stops there leaves the anchor at Infinity and the cutoff at
// NaN, which reads as "nothing is in window" for the whole list.
test("rankItineraries still answers when only exempt candidates survive", () => {
  const overCap = {
    itinerary: itin({
      departureTime: "2026-08-25T11:16:00+03:00",
      durationSeconds: 1200, walkSeconds: 1020,
      legs: [walk(510), ride("t-walkheavy"), walk(510)],
    }),
    probe: false,
  };
  const probe = {
    itinerary: itin({
      departureTime: "2026-08-25T12:10:00+03:00",
      durationSeconds: 900, walkSeconds: 120,
      legs: [walk(60), ride("t-probe"), walk(60)],
    }),
    probe: true,
  };

  const ranked = rankItineraries(
    [overCap, probe], (c) => c.itinerary, CFG, { exempt: (c) => c.probe },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.itinerary.departureTime, "2026-08-25T12:10:00+03:00");
});

// The exemption is per-candidate, not a global off switch: a NON-exempt
// candidate outside the window is still demoted, exactly as before.
test("rankItineraries still applies the window to non-exempt candidates", () => {
  const inWindow = {
    itinerary: itin({
      departureTime: "2026-08-25T11:20:00+03:00",
      durationSeconds: 1500, walkSeconds: 300,
      legs: [walk(150), ride("t-in"), walk(150)],
    }),
    probe: false,
  };
  const cheapButLate = {
    itinerary: itin({
      departureTime: "2026-08-25T12:30:00+03:00",
      durationSeconds: 300, walkSeconds: 60,
      legs: [walk(30), ride("t-late"), walk(30)],
    }),
    probe: false,
  };

  const ranked = rankItineraries(
    [cheapButLate, inWindow], (c) => c.itinerary, CFG, { exempt: (c) => c.probe },
  );
  assert.deepEqual(
    ranked.map((c) => c.itinerary.departureTime),
    ["2026-08-25T11:20:00+03:00", "2026-08-25T12:30:00+03:00"],
  );
});

// The `arriveBy` rule, at the unit level: the route
// handler passes `exempt: () => true` there, which must reduce the ordering to
// cost alone. `arriveBy 09:00`, direct bus 07:00 -> 08:45 (105 min) against a
// two-bus 08:00 -> 08:50 (50 min): with arrival pinned, the later departure is
// strictly better and must rank first.
test("rankItineraries orders purely on cost when every candidate is exempt", () => {
  const longDirect = itin({
    departureTime: "2026-08-25T07:00:00+03:00",
    durationSeconds: 6300, walkSeconds: 300, transfers: 0,
    legs: [walk(150), ride("t-direct"), walk(150)],
  });
  const shortTwoBus = itin({
    departureTime: "2026-08-25T08:00:00+03:00",
    durationSeconds: 3000, walkSeconds: 300, transfers: 1,
    legs: [walk(150), ride("t-a"), ride("t-b"), walk(150)],
  });

  const ranked = rankItineraries(
    [longDirect, shortTwoBus], ID, CFG, { exempt: () => true },
  );
  assert.deepEqual(
    ranked.map((i) => i.departureTime),
    ["2026-08-25T08:00:00+03:00", "2026-08-25T07:00:00+03:00"],
  );
});

// The sparse case, and the property most at risk from a naive window: when
// nothing runs for hours, the anchor moves to that first service instead of
// cutting it off. This must NOT return an empty list.
test("rankItineraries anchors on the first surviving departure, not on now", () => {
  const onlyOption = itin({
    departureTime: "2026-08-25T14:00:00+03:00",
    durationSeconds: 900, walkSeconds: 180,
    legs: [walk(120), ride("t-only"), walk(60)],
  });
  const ranked = rankItineraries([onlyOption], ID, CFG);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.departureTime, "2026-08-25T14:00:00+03:00");
});

test("rankItineraries keeps parallel data attached through the reorder", () => {
  const slow = itin({
    departureTime: "2026-08-25T11:16:00+03:00",
    durationSeconds: 1500, walkSeconds: 300,
    legs: [walk(150), ride("t-slow"), walk(150)],
  });
  const fast = itin({
    departureTime: "2026-08-25T11:39:00+03:00",
    durationSeconds: 600, walkSeconds: 120,
    legs: [walk(60), ride("t-fast"), walk(60)],
  });

  const ranked = rankItineraries(
    [{ itinerary: slow, tag: "slow" }, { itinerary: fast, tag: "fast" }],
    (c) => c.itinerary, CFG,
  );
  assert.deepEqual(ranked.map((c) => c.tag), ["fast", "slow"]);
});

test("rankItineraries returns an empty list unchanged", () => {
  assert.deepEqual(rankItineraries([], ID, CFG), []);
});
