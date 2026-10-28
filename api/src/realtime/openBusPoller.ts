import { brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import { Stream, REAL_SCHEDULER } from "./stream.js";
import type { PollerScheduler } from "./stream.js";
import type { FetchJson, SiriLogger } from "./poller.js";
import type { RealtimeStore } from "./store.js";
import type { ResolvedJourney, MatchStats, UnscheduledRun } from "./match.js";
import type { RealtimeJourney } from "./types.js";
import {
  parseOpenBusSnapshot, latestSnapshotId, statusUrl, snapshotUrl,
} from "./openBus.js";

const brotliDecompressAsync = promisify(brotliDecompress);

/** Fetches one snapshot file and returns its decoded, parsed JSON, or
 *  rejects. Injected so the poller's tests never touch the network. */
export type FetchSnapshot = (url: string) => Promise<unknown>;

/**
 * ~270 KB at the observed national peak (2026-09-10 08:30). Sixty times that
 * is still nothing a real snapshot will reach; it exists to stop a misrouted
 * response -- an unrelated large file -- before it is read into memory.
 */
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;

/**
 * 4.4 MB decoded at that peak. The cap on what ARRIVES says nothing about
 * what it decodes to -- a few hundred brotli bytes can expand to gigabytes --
 * so the decoder enforces its own. Same ceiling, and the same reasoning, as
 * `poller.ts`'s MAX_SIRI_RESPONSE_BYTES for the MOT feed itself.
 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

export interface CreateFetchSnapshotOptions {
  /** Tests pass small caps so the over-cap paths need no large payloads. */
  maxCompressedBytes?: number;
  maxDecodedBytes?: number;
}

/**
 * The production `FetchSnapshot`. The requester serves each `.br` as an
 * opaque `application/octet-stream` with NO `Content-Encoding` (checked
 * 2026-09-13), so `fetch` hands the compressed bytes over as-is and they are
 * decoded here. Decoding is asynchronous: a 4.4 MB decode every minute has no
 * business blocking the event loop that serves `/plan`.
 */
export function createFetchSnapshot(
  timeoutMs: number, opts: CreateFetchSnapshotOptions = {},
): FetchSnapshot {
  const maxCompressed = opts.maxCompressedBytes ?? MAX_COMPRESSED_BYTES;
  const maxDecoded = opts.maxDecodedBytes ?? MAX_DECODED_BYTES;

  return async (url: string): Promise<unknown> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxCompressed) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`snapshot too large: Content-Length ${declared} exceeds ${maxCompressed} bytes`);
    }
    // Checked again on what actually arrived: Content-Length can be absent.
    const compressed = Buffer.from(await res.arrayBuffer());
    if (compressed.byteLength > maxCompressed) {
      throw new Error(`snapshot too large: ${compressed.byteLength} bytes exceeds ${maxCompressed}`);
    }

    let decoded: Buffer;
    try {
      decoded = await brotliDecompressAsync(compressed, { maxOutputLength: maxDecoded });
    } catch (err) {
      if (err instanceof RangeError) {
        throw new Error(`snapshot too large: decodes past ${maxDecoded} bytes`);
      }
      throw new Error(`could not decode snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      return JSON.parse(decoded.toString("utf8"));
    } catch {
      throw new Error("could not decode snapshot: not valid JSON");
    }
  };
}

export interface OpenBusPollerOptions {
  baseUrl: string;
  pollSeconds: number;
  /** Per-visit ghost cutoff; see `openBus.ts`'s `parseVisit`. */
  maxVehicleAgeSeconds: number;
  store: RealtimeStore;
  /** Matches journeys onto the live index; injected for the same reason
   *  `StridePoller` injects it. */
  resolve: (journeys: readonly RealtimeJourney[], fetchedAt: number)
    => { resolved: ResolvedJourney[]; stats: MatchStats; unscheduled?: UnscheduledRun[] };
  /** Reads `daemon_status.json`. */
  fetchJson: FetchJson;
  /** Reads one `.br` snapshot. */
  fetchSnapshot: FetchSnapshot;
  /** Epoch seconds. Defaults to the wall clock. */
  now?: () => number;
  logger?: SiriLogger;
  scheduler?: PollerScheduler;
}

/**
 * Keeps a `RealtimeStore` current from the requester's per-minute snapshots.
 *
 * Each tick reads the 84-byte `daemon_status.json` and downloads the snapshot
 * it names only if that minute is not already in the store. Polling the
 * status well inside the minute is what makes the data fresh; downloading
 * only new minutes is what keeps that cheap for their server.
 */
export class OpenBusPoller {
  private readonly stream: Stream;
  private readonly now: () => number;
  /**
   * The minute now held in the store. Advanced only AFTER that snapshot is
   * stored, so a failed download is retried on the next tick rather than
   * being remembered as done.
   */
  private storedSnapshotId: string | null = null;

  constructor(private readonly opts: OpenBusPollerOptions) {
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.stream = new Stream(
      // Not `pollIntervalMs`: its 15 s floor is the MOT ICD's rule for MOT's
      // service. `config.ts` enforces this feed's own floor.
      opts.pollSeconds * 1000,
      () => this.tick(),
      opts.scheduler ?? REAL_SCHEDULER,
    );
  }

  start(): void { this.stream.start(); }
  stop(): void { this.stream.stop(); }
  get consecutiveFailures(): number { return this.stream.failureCount; }

  /** One tick, for the live check. Never rejects. */
  async tickOnce(): Promise<boolean> {
    return this.tick();
  }

  private async tick(): Promise<boolean> {
    let status: unknown;
    try {
      status = await this.opts.fetchJson(statusUrl(this.opts.baseUrl));
    } catch {
      return false;
    }

    const snapshotId = latestSnapshotId(status);
    if (snapshotId === null) {
      this.opts.logger?.warn("open-bus: daemon_status.json carried no usable snapshot id");
      return false;
    }

    // Already stored. A success, not a failure to back off from -- and
    // deliberately NOT a `replace()`: re-stamping the same snapshot as
    // freshly fetched would keep it "ok" forever if their requester stalled,
    // when it should go stale on its own.
    if (snapshotId === this.storedSnapshotId) return true;

    const fetchedAt = this.now();
    let payload: unknown;
    try {
      payload = await this.opts.fetchSnapshot(snapshotUrl(this.opts.baseUrl, snapshotId));
    } catch (err) {
      this.opts.logger?.warn(
        `open-bus: snapshot ${snapshotId} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    const snap = parseOpenBusSnapshot(payload, {
      now: fetchedAt, maxVehicleAgeSeconds: this.opts.maxVehicleAgeSeconds,
    });
    if (snap === null) {
      this.opts.logger?.warn(`open-bus: snapshot ${snapshotId} is not a SIRI stop-monitoring delivery`);
      return false;
    }

    const { resolved, stats, unscheduled } = this.opts.resolve(snap.journeys, fetchedAt);
    this.opts.store.replace(resolved, stats, fetchedAt, unscheduled ?? []);
    this.storedSnapshotId = snapshotId;
    this.opts.logger?.info?.(
      `open-bus: snapshot ${snapshotId}, ${snap.rowsSeen} visits, ${snap.rowsDropped} dropped, ` +
      `${stats.resolved} resolved (${stats.attached ?? 0} by slot), ${stats.unscheduled ?? 0} unscheduled, ` +
      `${stats.unresolved} unresolved`,
    );
    return true;
  }
}
