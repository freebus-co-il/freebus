import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters, type LatLon } from "../geo.js";
import { RailGraph, type RailWay } from "./railGraph.js";

// At this latitude 0.001° of latitude is ~111 m and 0.001° of longitude ~94 m.

function way(nodeIds: number[], points: LatLon[]): RailWay {
  return { nodeIds, points };
}

function lengthOf(line: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversineMeters(line[i - 1]!, line[i]!);
  return total;
}

test("a route follows the track's own vertices, not the chord between stations", () => {
  const graph = RailGraph.fromWays([
    way([1, 2, 3], [[32.000, 34.800], [32.005, 34.802], [32.010, 34.800]]),
  ]);
  const line = graph.route([32.000, 34.800], [32.010, 34.800]);
  assert.ok(line);
  assert.ok(line.some((p) => haversineMeters(p, [32.005, 34.802]) < 1), "passes the bend");
});

test("ways that share an OSM node are one network", () => {
  // OSM splits a railway into many ways; a junction is a node they share.
  const graph = RailGraph.fromWays([
    way([1, 2], [[32.000, 34.800], [32.005, 34.800]]),
    way([2, 3], [[32.005, 34.800], [32.010, 34.800]]),
  ]);
  const line = graph.route([32.000, 34.800], [32.010, 34.800]);
  assert.ok(line);
  assert.ok(Math.abs(lengthOf(line) - haversineMeters([32.000, 34.800], [32.010, 34.800])) < 5);
});

test("tracks that merely cross at the same coordinate are not a junction", () => {
  // A diamond crossing: two lines meet at a point without being connected.
  // Welding on coordinates instead of node ids would invent a junction here.
  const graph = RailGraph.fromWays([
    way([1, 2, 3], [[32.000, 34.800], [32.005, 34.805], [32.010, 34.810]]),
    way([4, 5, 6], [[32.010, 34.800], [32.005, 34.805], [32.000, 34.810]]),
  ]);
  assert.equal(graph.route([32.000, 34.800], [32.000, 34.810]), null);
});

test("a train does not reverse at a switch", () => {
  // Main line runs north through junction J; a branch leaves J to the
  // north-east. From the main line NORTH of J to the branch, the only way is
  // to run south to J and back out north-east -- a reversal no train makes.
  const graph = RailGraph.fromWays([
    way([1, 2, 3], [[31.990, 34.800], [32.000, 34.800], [32.010, 34.800]]),
    way([2, 4, 5], [[32.000, 34.800], [32.005, 34.803], [32.010, 34.808]]),
  ]);
  assert.equal(graph.route([32.010, 34.800], [32.010, 34.808]), null);
});

test("a switch taken in its facing direction is a route", () => {
  const graph = RailGraph.fromWays([
    way([1, 2, 3], [[31.990, 34.800], [32.000, 34.800], [32.010, 34.800]]),
    way([2, 4, 5], [[32.000, 34.800], [32.005, 34.803], [32.010, 34.808]]),
  ]);
  const line = graph.route([31.990, 34.800], [32.010, 34.808]);
  assert.ok(line);
  assert.ok(line.some((p) => haversineMeters(p, [32.005, 34.803]) < 1), "via the branch");
});

test("a sharp kink over a few metres of track does not block a route", () => {
  // OSM switches are often drawn with a 2-3 m stub at an odd angle; bearings
  // over segments that short are noise, not a turn the train makes.
  const graph = RailGraph.fromWays([
    way([1, 2, 3, 4], [
      [32.000, 34.800], [32.005, 34.800], [32.005, 34.80003], [32.010, 34.80003],
    ]),
  ]);
  assert.ok(graph.route([32.000, 34.800], [32.010, 34.80003]));
});

test("stations on different tracks of a multi-track line still route along the line", () => {
  // Two parallel, unconnected tracks ~19 m apart. The board station is
  // nearest the western track and the alight station nearest the eastern one.
  // Snapping each to its single nearest node would find no route at all (or,
  // on the real network, a detour round the country to change tracks).
  const graph = RailGraph.fromWays([
    way([1, 2], [[32.000, 34.8000], [32.010, 34.8000]]),
    way([3, 4], [[32.000, 34.8002], [32.010, 34.8002]]),
  ]);
  const from: LatLon = [32.000, 34.79995];
  const to: LatLon = [32.010, 34.80025];
  const line = graph.route(from, to);
  assert.ok(line);
  assert.ok(lengthOf(line) < haversineMeters(from, to) * 1.1);
});

test("a station nowhere near any track has no route", () => {
  const graph = RailGraph.fromWays([
    way([1, 2], [[32.000, 34.800], [32.010, 34.800]]),
  ]);
  assert.equal(graph.route([32.000, 34.900], [32.010, 34.800]), null);
});
