import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TimetableIndex } from "./index.js";
import type { ValhallaClient } from "../walking/valhalla.js";
import { straightLineWalk } from "../walking/valhalla.js";
import { haversineMeters, type LatLon } from "../geo.js";

export interface FootpathArrays {
  /** Stop s's footpaths occupy [offsets[s], offsets[s+1]). Length nStops + 1. */
  offsets: Int32Array;
  targets: Int32Array;
  /** Walk duration plus the boarding buffer, in seconds. */
  seconds: Int32Array;
}

export interface FootpathOptions {
  maxMeters: number;
  sameStationSeconds: number;
  transferMinSeconds: number;
  batchSize: number;
  speedMps: number;
  onProgress?: (done: number, total: number) => void;
}

const METERS_PER_DEG_LAT = 111_320;

/**
 * Candidate stop pairs within `maxMeters` straight-line.
 *
 * This filter is complete, not heuristic: straight-line distance is a lower
 * bound on street distance, so a pair whose real walk is under the cap can
 * never have a straight-line distance above it. Nothing valid is discarded
 * by the exact haversine check at the end of this function.
 *
 * The bucketing grid itself must also not discard anything. A degree of
 * longitude covers fewer metres than a degree of latitude away from the
 * equator (by a factor of cos(lat)), so sizing the longitude cell in degrees
 * the same as the latitude cell (as if 1 lon-degree == 1 lat-degree
 * everywhere) would make longitude cells physically *narrower* than
 * `maxMeters` at this feed's latitudes (~29-33N, cos ~0.85-0.875) -- and the
 * 3x3-cell neighbour search only guarantees catching a pair whose coordinate
 * gap is within one cell width. A pair could then straddle a cell boundary
 * unnoticed and be silently dropped, breaking the completeness property
 * above. To stay conservative everywhere in this data set, the longitude
 * cell is widened by 1/cos(maxAbsLat): since cos(lat) only *grows* as you
 * move toward the equator from the data set's most poleward point, this
 * width is a safe upper bound for every stop, not just the extreme one.
 *
 * A uniform grid rather than the database's R*Tree, so this module needs no
 * SQL and can be tested against a hand-built index.
 */
export function candidatePairs(
  index: TimetableIndex, maxMeters: number,
): Map<number, number[]> {
  const cellLat = maxMeters / METERS_PER_DEG_LAT;

  let maxAbsLat = 0;
  for (let s = 0; s < index.nStops; s++) {
    const abs = Math.abs(index.stopLat[s]!);
    if (abs > maxAbsLat) maxAbsLat = abs;
  }
  // Floor cosRef away from 0 so a data set that reaches near the poles
  // widens the longitude cell instead of dividing by (near-)zero.
  const cosRef = Math.max(Math.cos((maxAbsLat * Math.PI) / 180), 0.01);
  const cellLon = cellLat / cosRef;

  const grid = new Map<string, number[]>();
  const keyOf = (lat: number, lon: number): string =>
    `${Math.floor(lat / cellLat)}:${Math.floor(lon / cellLon)}`;

  for (let s = 0; s < index.nStops; s++) {
    const k = keyOf(index.stopLat[s]!, index.stopLon[s]!);
    const bucket = grid.get(k);
    if (bucket === undefined) grid.set(k, [s]); else bucket.push(s);
  }

  const out = new Map<number, number[]>();
  for (let s = 0; s < index.nStops; s++) {
    const lat = index.stopLat[s]!;
    const lon = index.stopLon[s]!;
    const gx = Math.floor(lat / cellLat);
    const gy = Math.floor(lon / cellLon);
    const near: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const t of grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
          if (t === s) continue;
          const d = haversineMeters([lat, lon], [index.stopLat[t]!, index.stopLon[t]!]);
          if (d <= maxMeters) near.push(t);
        }
      }
    }
    out.set(s, near);
  }
  return out;
}

/**
 * Groups every stop by station, keyed on the station's own stop index.
 * A group contains the station stop itself plus every child whose
 * `stopParent` points at it -- so looking up either a child or the station
 * by its own index (see `stationPeers`) yields every other member.
 *
 * Built once per `buildFootpaths` call, independent of any distance filter:
 * this is what lets same-station pairs bypass the `maxMeters` prefilter
 * entirely (see `stationPeers`).
 */
function buildStationGroups(index: TimetableIndex): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (let s = 0; s < index.nStops; s++) {
    const p = index.stopParent[s]!;
    if (p === -1) continue;
    let g = groups.get(p);
    if (g === undefined) {
      // The station itself is a member of its own group so that querying
      // the station's own index (not just a child's) also finds its peers.
      g = [p];
      groups.set(p, g);
    }
    g.push(s);
  }
  return groups;
}

/**
 * Every other stop sharing s's station: siblings under the same parent, s's
 * parent (if s is a child), and s's children (if s is itself a station).
 * Deliberately independent of `maxMeters` -- platform interchange is not a
 * street walk, so its cost is not a function of straight-line distance, and
 * a station whose platforms sit farther apart than the walking-radius
 * prefilter must still get an interchange footpath.
 */
function stationPeers(index: TimetableIndex, groups: Map<number, number[]>, s: number): number[] {
  const p = index.stopParent[s]!;
  const key = p !== -1 ? p : s;
  const g = groups.get(key);
  if (g === undefined) return [];
  return g.filter((u) => u !== s);
}

/**
 * Rounds a computed leg cost and asserts it lands in the range this array
 * format can represent. A NaN or negative value here would come from a
 * config mistake (a negative `transferMinSeconds`/`sameStationSeconds`) or
 * from something upstream returning nonsense that already slipped past the
 * per-pair validation in the caller -- either way it must not be written
 * into `seconds` silently, since a downstream router would then treat a
 * negative or NaN edge weight as free or as "shortest possible".
 */
function finalizeSeconds(raw: number): number {
  const rounded = Math.round(raw);
  if (!Number.isFinite(rounded) || rounded < 0) {
    throw new Error(`invalid footpath duration (must be finite and >= 0): ${raw}`);
  }
  return rounded;
}

export async function buildFootpaths(
  index: TimetableIndex,
  client: Pick<ValhallaClient, "ping" | "matrix">,
  opts: FootpathOptions,
): Promise<{ arrays: FootpathArrays; mode: "valhalla" | "straight-line" }> {
  const pairs = candidatePairs(index, opts.maxMeters);
  const stationGroups = buildStationGroups(index);
  const useValhalla = await client.ping();

  const offsets = new Int32Array(index.nStops + 1);
  const targets: number[] = [];
  const seconds: number[] = [];

  let done = 0;
  const total = index.nStops;

  for (let s = 0; s < index.nStops; s++) {
    offsets[s] = targets.length;
    const near = pairs.get(s) ?? [];

    // Station peers bypass the maxMeters walking-radius prefilter entirely:
    // a large interchange's platforms can sit farther apart than the
    // prefilter allows, and platform interchange is not a street walk in
    // the first place, so its cost cannot depend on straight-line distance.
    const peers = stationPeers(index, stationGroups, s);
    const peerSet = new Set(peers);
    // Anything already emitted as a station peer is excluded here so no
    // pair is ever written twice, even when it also happens to fall inside
    // the walking radius.
    const street = near.filter((t) => !peerSet.has(t));

    for (const t of peers) {
      targets.push(t);
      seconds.push(finalizeSeconds(opts.sameStationSeconds + opts.transferMinSeconds));
    }

    if (street.length > 0) {
      const from: LatLon = [index.stopLat[s]!, index.stopLon[s]!];
      let costs: ({ durationSeconds: number } | null)[] = [];

      if (useValhalla) {
        try {
          const chunked: ({ durationSeconds: number } | null)[] = [];
          for (let i = 0; i < street.length; i += opts.batchSize) {
            const slice = street.slice(i, i + opts.batchSize);
            const m = await client.matrix(
              [from],
              slice.map((t) => [index.stopLat[t]!, index.stopLon[t]!] as LatLon),
            );
            chunked.push(...(m[0] ?? slice.map(() => null)));
          }
          costs = chunked;
        } catch {
          costs = [];
        }
      }

      for (let i = 0; i < street.length; i++) {
        const t = street[i]!;
        const cost = costs[i];
        // A cost is only trusted when it is present *and* a finite,
        // non-negative number: a malformed or adversarial matrix response
        // (e.g. a fake client in a test, or a future Valhalla contract
        // change) degrades this single pair to the straight-line estimate
        // rather than writing NaN/negative straight into the cache.
        const walkSeconds = cost != null
          && Number.isFinite(cost.durationSeconds)
          && cost.durationSeconds >= 0
          ? cost.durationSeconds
          : straightLineWalk(
              from, [index.stopLat[t]!, index.stopLon[t]!], opts.speedMps,
            ).durationSeconds;
        targets.push(t);
        seconds.push(finalizeSeconds(walkSeconds + opts.transferMinSeconds));
      }
    }

    done++;
    opts.onProgress?.(done, total);
  }
  offsets[index.nStops] = targets.length;

  return {
    arrays: {
      offsets,
      targets: Int32Array.from(targets),
      seconds: Int32Array.from(seconds),
    },
    mode: useValhalla ? "valhalla" : "straight-line",
  };
}

/**
 * Every option whose value changes the CONTENT of the footpath arrays, and
 * which therefore has to be part of the cache key.
 *
 * `batchSize` is deliberately absent: it only decides how the Valhalla
 * matrix calls are chunked, and chunking cannot change a single computed
 * duration. Including it would invalidate a several-hundred-thousand-pair
 * cache over a purely operational tuning knob.
 */
export type FootpathCacheKeyOptions =
  Pick<FootpathOptions, "maxMeters" | "sameStationSeconds" | "transferMinSeconds" | "speedMps">;

/**
 * The cache key: the stop set AND the options the cached arrays were built
 * with.
 *
 * Keyed on the stop set rather than the feed version because stops barely
 * change between nightly imports, so this cache survives most refreshes —
 * which matters, because regenerating it means pushing hundreds of thousands
 * of pairs back through Valhalla.
 *
 * The OPTIONS have to be in the key for a different reason: they are baked
 * into every number in the file. `maxMeters` decides which pairs exist at
 * all; `transferMinSeconds` is added to every edge; `sameStationSeconds` is
 * the entire cost of every station-peer edge; `speedMps` scales every
 * straight-line estimate. Keying on the stop set alone meant an operator
 * could retune any of them, restart, and silently get the OLD values back
 * from cache — with `/meta` still reporting `footpaths: "valhalla"`, so
 * nothing anywhere signalled that the change had not taken effect. Folding
 * them in makes a retune miss the cache and rebuild, which is the whole
 * point of retuning.
 */
export function stopSetHash(index: TimetableIndex, opts: FootpathCacheKeyOptions): string {
  const h = createHash("sha256");
  // Options first, and each one labelled: a bare concatenation of numbers
  // could be made ambiguous by a future field (60|180 vs 6|0180), and a
  // collision here is exactly the silent-stale-cache failure this fixes.
  h.update(`maxMeters=${opts.maxMeters}\n`);
  h.update(`sameStationSeconds=${opts.sameStationSeconds}\n`);
  h.update(`transferMinSeconds=${opts.transferMinSeconds}\n`);
  h.update(`speedMps=${opts.speedMps}\n`);
  for (let s = 0; s < index.nStops; s++) {
    h.update(`${index.stopIds[s]}|${index.stopLat[s]}|${index.stopLon[s]}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

const MAGIC = 0x54465031; // "TFP1"
const FORMAT_VERSION = 1;

function cachePath(dir: string, hash: string): string {
  return join(dir, `footpaths-${hash}.bin`);
}

/**
 * The magic and version go first so that adding a field later cannot silently
 * misread a stale file as the new layout — the schema-drift bug class that
 * made the timetable index not worth caching at all.
 */
export function saveFootpathCache(dir: string, hash: string, a: FootpathArrays): void {
  mkdirSync(dir, { recursive: true });
  const header = Int32Array.from([
    MAGIC, FORMAT_VERSION, a.offsets.length, a.targets.length,
  ]);
  const buf = Buffer.concat([
    Buffer.from(header.buffer),
    Buffer.from(a.offsets.buffer, a.offsets.byteOffset, a.offsets.byteLength),
    Buffer.from(a.targets.buffer, a.targets.byteOffset, a.targets.byteLength),
    Buffer.from(a.seconds.buffer, a.seconds.byteOffset, a.seconds.byteLength),
  ]);
  // Written to a temporary name and renamed, so a crash mid-write can never
  // leave a truncated file that looks valid — the same discipline the fetcher
  // uses when publishing a database.
  const tmp = `${cachePath(dir, hash)}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, cachePath(dir, hash));
}

export function loadFootpathCache(dir: string, hash: string): FootpathArrays | null {
  let buf: Buffer;
  try {
    buf = readFileSync(cachePath(dir, hash));
  } catch {
    return null;
  }
  if (buf.byteLength < 16) return null;

  // Copy every field out of the file buffer rather than viewing it in place.
  // readFileSync can return a Buffer backed by Node's shared allocation pool,
  // whose `byteOffset` into the underlying ArrayBuffer is *not* guaranteed to
  // be a multiple of 4 -- it depends on whatever else has been allocated from
  // that pool before it. `new Int32Array(buf.buffer, buf.byteOffset, n)`
  // would then either throw (misalignment is rejected by the TypedArray
  // constructor) or, worse, read from a coincidentally-"aligned" but wrong
  // byte position. `ArrayBuffer#slice` always copies into a fresh,
  // zero-offset buffer first, so the following `Int32Array` view is safe
  // regardless of where the source buffer landed in the pool.
  let at = buf.byteOffset;
  const read = (n: number): Int32Array => {
    const arr = Int32Array.from(new Int32Array(buf.buffer.slice(at, at + n * 4)));
    at += n * 4;
    return arr;
  };

  const header = read(4);
  if (header[0] !== MAGIC || header[1] !== FORMAT_VERSION) return null;

  const nOffsets = header[2]!;
  const nEdges = header[3]!;
  const expected = 16 + (nOffsets + nEdges * 2) * 4;
  if (buf.byteLength !== expected) return null;

  return { offsets: read(nOffsets), targets: read(nEdges), seconds: read(nEdges) };
}
