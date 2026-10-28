import { Stream, REAL_SCHEDULER } from "./stream.js";
import type { PollerScheduler } from "./stream.js";
import type { FetchJson, SiriLogger } from "./poller.js";
import type { RealtimeStore } from "./store.js";
import type { ResolvedJourney, MatchStats, UnscheduledRun } from "./match.js";
import type { RealtimeJourney } from "./types.js";
import {
  parseStrideRows, strideUrl, snapshotsUrl, latestLoadedSnapshotId,
} from "./stride.js";

/**
 * Polls Stride's national vehicle-position feed on one timer and keeps a
 * `RealtimeStore` current.
 *
 * Deliberately much smaller than `SiriPoller`: one stream rather than two
 * (so no cross-stream merge or dedupe), no API key (so nothing to redact
 * from a URL or a response body), and no delivery envelope to validate.
 *
 * What it has that `SiriPoller` does not is PAGING. Stride caps a response
 * at 15,000 rows -- its own error text attributes the cap to abuse -- and
 * the observed national peak is 10,020, so one request usually suffices but
 * must never be assumed to.
 */
export interface StridePollerOptions {
  baseUrl: string;
  pollSeconds: number;
  /**
   * Per-row ghost cutoff on `recorded_at_time` -- NOT the snapshot
   * staleness. See `stride.ts`'s `parseRow`: reusing the 180 s snapshot age
   * here would leave ~70 s of margin over Stride's own ingestion lag and
   * discard buses that merely report every two minutes.
   */
  maxVehicleAgeSeconds: number;
  pageLimit: number;
  maxPages: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  store: RealtimeStore;
  /**
   * Matches a batch of journeys onto the timetable index. Injected for the
   * same reason `SiriPoller` injects it: resolution needs the current
   * bundle's calendar, and this file stays ignorant of both the index and
   * the bundle.
   */
  resolve: (journeys: readonly RealtimeJourney[], fetchedAt: number)
    => { resolved: ResolvedJourney[]; stats: MatchStats; unscheduled?: UnscheduledRun[] };
  fetchJson: FetchJson;
  /** Epoch seconds. Defaults to the wall clock; tests inject a fixed one. */
  now?: () => number;
  logger?: SiriLogger;
  scheduler?: PollerScheduler;
}

export class StridePoller {
  private readonly stream: Stream;
  private readonly now: () => number;

  constructor(private readonly opts: StridePollerOptions) {
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.stream = new Stream(
      // Not `pollIntervalMs`: that clamps to the ministry ICD's 15-second
      // floor, which is a rule about MOT's service, not this one. Stride
      // publishes once a minute and `config.ts` enforces its own floor.
      opts.pollSeconds * 1000,
      () => this.tick(),
      opts.scheduler ?? REAL_SCHEDULER,
    );
  }

  start(): void { this.stream.start(); }
  stop(): void { this.stream.stop(); }
  get consecutiveFailures(): number { return this.stream.failureCount; }

  /**
   * One poll. Never rejects: every failure path returns `false` so `Stream`
   * can back off, and a thrown fetch becomes a failed tick rather than an
   * unhandled rejection.
   *
   * The store is replaced only on a FULLY successful tick. A partial result
   * -- one page fetched, the next threw -- is discarded rather than written,
   * because a half-national snapshot would present as "these buses have no
   * realtime" for whichever half went missing, which is indistinguishable
   * from the truth and therefore worse than briefly serving the previous
   * snapshot until it goes stale on its own.
   *
   * Exposed (rather than private) so a test, and the live check, can run
   * exactly one tick without driving a fake scheduler.
   */
  async tickOnce(): Promise<boolean> {
    return this.tick();
  }

  private async tick(): Promise<boolean> {
    const fetchedAt = this.now();
    const journeys: RealtimeJourney[] = [];
    let pages = 0;
    let rowsSeen = 0;
    let rowsDropped = 0;
    let truncated = false;

    let snapshotId: number;
    try {
      // Scope every tick to ONE snapshot. Without this the same vehicle
      // comes back once per snapshot in the window and, because rows arrive
      // newest-first, the store ends up holding each vehicle's OLDEST
      // position -- see `snapshotsUrl`'s own comment for the measurement.
      const listed = await this.opts.fetchJson(snapshotsUrl(this.opts.baseUrl));
      const latest = latestLoadedSnapshotId(listed);
      if (latest === null) {
        this.opts.logger?.warn("stride: no loaded snapshot available");
        return false;
      }
      snapshotId = latest;
    } catch {
      return false;
    }

    try {
      while (pages < this.opts.maxPages) {
        const url = strideUrl(this.opts.baseUrl, {
          ...this.opts.bbox,
          snapshotId,
          limit: this.opts.pageLimit,
          offset: pages * this.opts.pageLimit,
        });
        const payload = await this.opts.fetchJson(url);
        pages++;

        // Every error this API produces is a NON-ARRAY body: the "due to
        // abuse" cap message, a pydantic validation error, an HTML error
        // page. An empty ARRAY is a legitimately quiet feed and succeeds;
        // anything else is a failed tick. Without this check
        // `parseStrideRows` would report a well-formed empty snapshot and
        // the tick would look successful while silently wiping the store.
        if (!Array.isArray(payload)) return false;

        const snap = parseStrideRows(payload, {
          now: fetchedAt,
          maxVehicleAgeSeconds: this.opts.maxVehicleAgeSeconds,
        });
        journeys.push(...snap.journeys);
        rowsSeen += snap.rowsSeen;
        rowsDropped += snap.rowsDropped;

        // A short page is the end of the data. A full one means there may be
        // more -- and if that happens on the LAST allowed page, coverage is
        // incomplete and must be said out loud.
        if (payload.length < this.opts.pageLimit) break;
        if (pages >= this.opts.maxPages) truncated = true;
      }
    } catch {
      return false;
    }

    // Bounded paging must never masquerade as full coverage.
    if (truncated) {
      this.opts.logger?.warn(
        `stride: snapshot ${snapshotId} stopped at ${pages} pages (${rowsSeen} rows) ` +
        `with more available -- raise STRIDE_MAX_PAGES; coverage is incomplete`,
      );
    }

    const { resolved, stats, unscheduled } = this.opts.resolve(journeys, fetchedAt);
    this.opts.store.replace(resolved, stats, fetchedAt, unscheduled ?? []);
    this.opts.logger?.info?.(
      `stride: snapshot ${snapshotId}, ${rowsSeen} rows, ${rowsDropped} dropped, ` +
      `${stats.resolved} resolved (${stats.attached ?? 0} by slot), ${stats.unscheduled ?? 0} unscheduled, ` +
      `${stats.unresolved} unresolved`,
    );
    return true;
  }
}
