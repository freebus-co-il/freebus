import { haversineMeters, type LatLon } from "../geo.js";

/**
 * One OSM `railway=rail` way: its node ids and their coordinates, in order.
 * Both arrays are the same length; a way whose aren't is skipped.
 */
export interface RailWay {
  nodeIds: readonly number[];
  points: readonly LatLon[];
}

/**
 * A station further than this from every track is not on this network (a
 * stop the feed misplaced, or a line OSM does not have yet). Routing it would
 * only pick whichever unrelated track happens to be closest.
 */
const MAX_SNAP_METERS = 1_000;

/**
 * Every track node this close to a station is a place its train may stand.
 * Measured on the real network (2026-09-15): the worst station sits 256 m
 * from its nearest track node (רעננה דרום), so the window is relative to the
 * nearest node rather than absolute. Snapping to ONE node put a station on
 * one track of a multi-track section and routed the other direction round
 * the country to change tracks -- 236 km for the 2.1 km from לוד to לוד גני
 * אביב.
 */
const SNAP_WINDOW_METERS = 150;
const SNAP_BEYOND_NEAREST_METERS = 40;

/**
 * The sharpest change of heading a train makes between two track segments.
 * Without it a route may run into a switch and back out along the other leg
 * -- a reversal no service does, and a shortcut shortest-path always wants.
 */
const MAX_TURN_DEGREES = 45;

/**
 * Below this a segment's bearing is noise: OSM draws switches with 2-3 m
 * stubs at arbitrary angles. Enforcing the turn limit there made 14 of 203
 * real station pairs unroutable.
 */
const MIN_BEARING_SEGMENT_METERS = 8;

interface Edge { to: number; meters: number }

function bearingDegrees(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180;
  const dLon = (b[1] - a[1]) * toRad;
  const y = Math.sin(dLon) * Math.cos(b[0] * toRad);
  const x = Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad)
    - Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos(dLon);
  return Math.atan2(y, x) / toRad;
}

function turnDegrees(a: LatLon, b: LatLon, c: LatLon): number {
  const delta = bearingDegrees(b, c) - bearingDegrees(a, b);
  return Math.abs(((delta + 540) % 360) - 180);
}

/** Minimal binary heap of [cost, state] pairs, cheapest first. */
class MinHeap<T> {
  private readonly items: { cost: number; value: T }[] = [];
  get size(): number { return this.items.length; }
  push(cost: number, value: T): void {
    const items = this.items;
    items.push({ cost, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.cost <= items[i]!.cost) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  pop(): { cost: number; value: T } | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && items[l]!.cost < items[smallest]!.cost) smallest = l;
        if (r < items.length && items[r]!.cost < items[smallest]!.cost) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i]!, items[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * The rail network as a graph of OSM nodes, for drawing a train's path
 * between two stations. Used only when baking (`rail/bake.ts`): the API
 * itself serves the baked lines and never routes.
 */
export class RailGraph {
  private constructor(
    private readonly position: ReadonlyMap<number, LatLon>,
    private readonly edges: ReadonlyMap<number, readonly Edge[]>,
  ) {}

  /**
   * Welded on OSM NODE ID, never on coordinates: ways are split at junctions
   * and genuinely share the node there, while two lines that cross on a
   * diamond share a coordinate without being connected.
   */
  static fromWays(ways: readonly RailWay[]): RailGraph {
    const position = new Map<number, LatLon>();
    const edges = new Map<number, Edge[]>();
    const link = (from: number, to: number, meters: number): void => {
      let list = edges.get(from);
      if (list === undefined) { list = []; edges.set(from, list); }
      list.push({ to, meters });
    };
    for (const { nodeIds, points } of ways) {
      if (nodeIds.length !== points.length) continue;
      nodeIds.forEach((id, i) => position.set(id, points[i]!));
      for (let i = 1; i < nodeIds.length; i++) {
        const a = nodeIds[i - 1]!;
        const b = nodeIds[i]!;
        if (a === b) continue;
        const meters = haversineMeters(points[i - 1]!, points[i]!);
        link(a, b, meters);
        link(b, a, meters);
      }
    }
    return new RailGraph(position, edges);
  }

  /** Track nodes a train calling at `at` may stand on; empty when off-network. */
  private candidates(at: LatLon): number[] {
    const distances: { id: number; meters: number }[] = [];
    let nearest = Infinity;
    for (const [id, point] of this.position) {
      if (!this.edges.has(id)) continue;
      const meters = haversineMeters(at, point);
      distances.push({ id, meters });
      if (meters < nearest) nearest = meters;
    }
    if (nearest > MAX_SNAP_METERS) return [];
    const window = Math.max(SNAP_WINDOW_METERS, nearest + SNAP_BEYOND_NEAREST_METERS);
    return distances.filter((d) => d.meters <= window).map((d) => d.id);
  }

  /**
   * The shortest track path a train can take from a station at `from` to one
   * at `to`, as the track's own points -- or null when there is none.
   *
   * Edge-based Dijkstra: a state is (node, the node we came from), so the
   * turn limit can be applied to each step. Every candidate node of either
   * station is a source or target.
   */
  route(from: LatLon, to: LatLon): LatLon[] | null {
    const sources = this.candidates(from);
    const targets = new Set(this.candidates(to));
    if (sources.length === 0 || targets.size === 0) return null;

    const NONE = -1;
    const keyOf = (node: number, prev: number) => `${node}:${prev}`;
    const cost = new Map<string, number>();
    const cameFrom = new Map<string, { node: number; prev: number }>();
    const heap = new MinHeap<{ node: number; prev: number }>();
    for (const node of sources) {
      cost.set(keyOf(node, NONE), 0);
      heap.push(0, { node, prev: NONE });
    }

    while (heap.size > 0) {
      const { cost: here, value: state } = heap.pop()!;
      const { node, prev } = state;
      if (here > (cost.get(keyOf(node, prev)) ?? Infinity)) continue;

      if (targets.has(node)) {
        const path = [this.position.get(node)!];
        let step: { node: number; prev: number } | undefined = state;
        while ((step = cameFrom.get(keyOf(step.node, step.prev))) !== undefined) {
          path.push(this.position.get(step.node)!);
        }
        return path.reverse();
      }

      const at = this.position.get(node)!;
      const before = prev === NONE ? null : this.position.get(prev)!;
      for (const { to: next, meters } of this.edges.get(node) ?? []) {
        if (next === prev) continue;
        const ahead = this.position.get(next)!;
        if (before !== null
            && haversineMeters(before, at) >= MIN_BEARING_SEGMENT_METERS
            && meters >= MIN_BEARING_SEGMENT_METERS
            && turnDegrees(before, at, ahead) > MAX_TURN_DEGREES) continue;
        const total = here + meters;
        const key = keyOf(next, node);
        if (total < (cost.get(key) ?? Infinity)) {
          cost.set(key, total);
          cameFrom.set(key, state);
          heap.push(total, { node: next, prev: node });
        }
      }
    }
    return null;
  }
}
