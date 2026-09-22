import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePolyline, type LatLon } from "../geo.js";

/**
 * The baked file, `assets/rail-geometry.json`, written by `npm run bake:rail`.
 *
 * Exists because the MOT feed publishes NO shapes for rail: all 1,642 Israel
 * Railways trips (2026-09-14) carry an empty `shape_id`, so without this every
 * train is drawn as straight lines between its stations. The lines are routed
 * over OpenStreetMap's rail network once and committed; the track does not
 * move, and routing at request time would mean shipping the whole network.
 */
export interface BakedRailGeometry {
  /** When the OSM data was current, as Overpass reported it. */
  osmTimestamp: string;
  /** ODbL requires it wherever the lines are shown. */
  attribution: string;
  /**
   * Precision-6 encoded track line per pair of consecutive stations, keyed by
   * `railPairKey` -- once per undirected pair, drawn from the lower stop id's
   * station to the higher's.
   */
  lines: Record<string, string>;
}

export interface StationPoint {
  stopId?: string;
  lat: number;
  lon: number;
}

export interface RailGeometryLogger {
  warn(message: string): void;
}

export function railPairKey(a: string, b: string): { key: string; reversed: boolean } {
  return a <= b ? { key: `${a}>${b}`, reversed: false } : { key: `${b}>${a}`, reversed: true };
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
/**
 * `src/rail/` (dev) and `dist/rail/` (production) are both two levels below
 * `api/`, so this reaches `api/assets/` from either -- and
 * `/app/assets/` in the image, which the Dockerfile copies it to.
 */
export const DEFAULT_RAIL_GEOMETRY_FILE = resolve(moduleDir, "..", "..", "assets", "rail-geometry.json");

export class RailGeometry {
  private readonly decoded = new Map<string, LatLon[]>();
  private readonly reported = new Set<string>();

  private constructor(
    private readonly lines: Readonly<Record<string, string>>,
    private readonly onMissingPair: (key: string) => void,
  ) {}

  static fromBaked(
    baked: BakedRailGeometry, opts: { onMissingPair?: (key: string) => void } = {},
  ): RailGeometry {
    return new RailGeometry(baked.lines, opts.onMissingPair ?? (() => {}));
  }

  /**
   * A missing or unreadable file loads as EMPTY, with a warning: every train
   * then falls back to its stations, exactly as before this file existed,
   * rather than the API refusing to start over a drawing aid.
   */
  static load(file: string, logger: RailGeometryLogger = console): RailGeometry {
    const onMissingPair = (key: string) => logger.warn(
      `rail geometry: no baked line for station pair ${key}, drawing it through its stations `
      + "(the feed has changed -- re-run `npm run bake:rail`)",
    );
    try {
      const baked = JSON.parse(readFileSync(file, "utf8")) as BakedRailGeometry;
      if (typeof baked.lines !== "object" || baked.lines === null) {
        throw new Error("no `lines` object");
      }
      return RailGeometry.fromBaked(baked, { onMissingPair });
    } catch (err) {
      logger.warn(`rail geometry: could not load ${file} (${(err as Error).message}); `
        + "trains will be drawn through their stations");
      // Silent per pair: with no file EVERY pair is missing, and one warning
      // per station pair would bury the one above that says why.
      return RailGeometry.fromBaked({ osmTimestamp: "", attribution: "", lines: {} });
    }
  }

  get size(): number { return Object.keys(this.lines).length; }

  /**
   * The track line through these stations in order, starting on the first
   * and ending on the last -- or null unless EVERY consecutive pair is baked.
   *
   * All or nothing: half real track and half straight guess would still be
   * presented to the rider as the real line.
   */
  lineThrough(stations: readonly StationPoint[]): LatLon[] | null {
    if (stations.length < 2) return null;
    const first = stations[0]!;
    const last = stations[stations.length - 1]!;
    const line: LatLon[] = [[first.lat, first.lon]];

    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1]!.stopId;
      const b = stations[i]!.stopId;
      if (a === undefined || b === undefined) return null;
      if (a === b) continue;
      const { key, reversed } = railPairKey(a, b);
      const track = this.track(key);
      if (track === null) return null;
      if (reversed) {
        for (let j = track.length - 1; j >= 0; j--) line.push(track[j]!);
      } else {
        line.push(...track);
      }
    }

    line.push([last.lat, last.lon]);
    return line;
  }

  private track(key: string): LatLon[] | null {
    const cached = this.decoded.get(key);
    if (cached !== undefined) return cached;
    const encoded = this.lines[key];
    if (encoded === undefined) {
      if (!this.reported.has(key)) { this.reported.add(key); this.onMissingPair(key); }
      return null;
    }
    const points = decodePolyline(encoded);
    this.decoded.set(key, points);
    return points;
  }
}

let shared: RailGeometry | undefined;

/** The committed baked file, loaded on first use and kept for the process. */
export function defaultRailGeometry(): RailGeometry {
  shared ??= RailGeometry.load(DEFAULT_RAIL_GEOMETRY_FILE);
  return shared;
}
