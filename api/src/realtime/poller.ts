import {
  buildSnapshotUrl, parseSiriResponse, redactKey, throwOnServiceLevelError,
} from "./siri.js";
import { SiriError, type RealtimeJourney, type RealtimeCall } from "./types.js";
import type { ResolvedJourney, MatchStats, UnscheduledRun } from "./match.js";
import type { RealtimeStore } from "./store.js";
import { Stream, pollIntervalMs, REAL_SCHEDULER } from "./stream.js";
import type { PollerScheduler } from "./stream.js";
// Re-exported so every existing importer (wiring.ts, index.ts, the tests)
// keeps its current import path while the definitions live in stream.ts.
export type { PollerTimerHandle, PollerScheduler } from "./stream.js";





export interface SiriLogger {
  warn(message: string): void;
  /**
   * Optional: per-tick diagnostics (response size, parse duration) are not
   * warnings, so they go here when a caller provides it and are silently
   * skipped otherwise. `console` satisfies this already; every existing
   * test double that implements only `warn` keeps compiling and simply
   * never sees these lines. Visit-drop / stream-regression diagnostics
   * stay on `warn` -- they are genuine warnings, not routine per-tick
   * metrics.
   */
  info?(message: string): void;
}


/** Fetches a URL and returns its parsed JSON body, or rejects. The poller
 * is otherwise entirely ignorant of HTTP -- every test injects its own,
 * and `createFetchJson` below is the only real implementation. */
export type FetchJson = (url: string) => Promise<unknown>;

/**
 * Every error this module's own code (`createFetchJson`, `tick`'s envelope
 * gate) throws carries TWO messages: `message` (inherited from `Error`),
 * which MAY include third-party detail -- a redacted body excerpt, a
 * payload's own top-level key names -- and is safe for the LOG ONLY; and
 * `publicSummary`, a small FIXED-VOCABULARY string this codebase authored
 * (`"HTTP 401"`, `"invalid JSON body"`, `"no StopMonitoringDelivery"`,
 * `"response too large"`) that is the ONLY thing `tick()`'s catch block may
 * ever put into `streamDiagnostics[filter].lastError` -- which
 * `routes/meta.ts` serves publicly.
 *
 * Redacting the literal key (see
 * `redactLiteralKey`) is necessary but not SUFFICIENT to make third-party
 * text safe to serve publicly. An untrusted response body could contain
 * anything else -- other secrets, unexpectedly large text, control
 * characters, whatever a misbehaving intermediary or the ministry's own
 * error page happens to include -- and `/meta` is a public endpoint with no
 * business repeating any of it verbatim, redacted or not. A fixed
 * vocabulary this codebase chose sidesteps that risk entirely, rather than
 * trying to enumerate everything that might need redacting.
 */
class TickError extends Error {
  constructor(message: string, public readonly publicSummary: string) {
    super(message);
  }
}

/**
 * Replaces every LITERAL occurrence of `key` in `text` with `***`, however
 * it appears -- as a `Key=` URL parameter (already handled by `redactKey`
 * below), a JSON field value, string-concatenated into unrelated text,
 * anything. The ministry's own
 * error bodies have been observed (ICD §9) to echo the request back, and
 * that echo is NOT guaranteed to take URL-parameter shape -- a body like
 * `{"error":"unauthorized","Key":"<the real key>","request":"..."}` puts
 * the raw key value in a plain JSON field, which `redactKey`'s
 * `[?&]Key=[^&]*` pattern never matches at all. `text.split(key).join(...)`
 * is a literal substring replacement with no regex-escaping pitfalls --
 * correct for a key of ANY content, including characters that would need
 * escaping in a regex.
 *
 * A no-op when `key` is empty (defensive only; `resolveRealtimeConfig`
 * never allows an empty key to reach here).
 */
function redactLiteralKey(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("***");
}

/**
 * A single-line, bounded, KEY-REDACTED summary of a response body, for a
 * failed tick's log line ONLY -- never for a public
 * response; see `TickError.publicSummary` for what `/meta` may show
 * instead. Redacts the literal key value first (`redactLiteralKey`, the
 * general case -- see its own comment), then `redactKey`'s URL-parameter
 * form as belt and braces, THEN collapses whitespace (including newlines,
 * so one bad response can never spam more than one log line) and
 * truncates well short of any reasonable log-ingestion line-length limit.
 * Both redaction passes run BEFORE truncation: the key is a fixed-length
 * token, and truncating first could leave a partial key sitting in the
 * excerpt if the cut fell mid-token.
 */
function excerpt(text: string, key: string | null, maxChars = 500): string {
  // `null` key: an unauthenticated feed has nothing to redact, but the
  // URL-parameter pass still runs -- it costs nothing and cannot misfire.
  const redacted = redactKey(key === null ? text : redactLiteralKey(text, key));
  const oneLine = redacted.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

/**
 * A short description of an unrecognised JSON payload's shape -- its
 * top-level object keys, or its type/length when it isn't an object at all
 * -- for the "not a SIRI envelope" failure's LOG line ONLY, where there is
 * no raw body text left to excerpt (`fetchJson`
 * has already parsed it by the time `hasStopMonitoringDelivery` sees it).
 *
 * A FIELD NAME can be the literal key value -- `object{<the real key>,
 * other}` is a real shape an unrecognised payload can take, not a
 * hypothetical one. `key` is therefore a REQUIRED parameter:
 * `redactLiteralKey` runs on the joined key-name string before it is ever
 * returned, so this function cannot be called correctly without redacting.
 * Still not safe for `/meta` even after that: field names are still
 * untrusted, ministry/attacker-influenced text -- arbitrarily many of them,
 * of arbitrary content beyond just the key -- so `tick()`'s catch NEVER
 * copies this into `publicSummary`, only into the thrown `TickError`'s
 * `message` (log-only).
 */
function describePayloadShape(payload: unknown, key: string): string {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return `array(length=${payload.length})`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as Record<string, unknown>);
  return redactLiteralKey(`object{${keys.slice(0, 20).join(", ")}}`, key);
}

/**
 * Bytes. A SIRI response over this size fails the tick outright rather than
 * risking unbounded memory use parsing it -- a judgement call, since
 * snapshot size and parse cost were entirely unmeasured before a real key
 * exists, on a 2-vCPU/4GB box this shares with a Valhalla process and
 * RAPTOR's own sizeable in-memory index. 64 MiB every 15-30s would already
 * be a serious latency problem long before it threatens the process's
 * total memory, so this cap exists to catch a genuinely runaway or
 * misrouted response (a redirect loop, a proxy mistakenly handing back an
 * unrelated multi-hundred-MB file) rather than to be the mechanism that
 * keeps ordinary traffic within budget -- `REALTIME_POLL_SECONDS` and the
 * `calls`-detail choice remain the levers for that.
 */
const MAX_SIRI_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface CreateFetchJsonOptions {
  /** Per-tick diagnostics (response size, parse duration) go
   * through `logger.info`, when provided -- see `SiriLogger`. Defaults to
   * `console`, matching every other logger default in this file. */
  logger?: SiriLogger;
  /** Overrides `MAX_SIRI_RESPONSE_BYTES` -- tests use a small cap so the
   * over-cap path doesn't require allocating a genuinely huge string. */
  maxBytes?: number;
}

/**
 * The production `FetchJson`: `fetch` with a timeout, using
 * `REALTIME_TIMEOUT_MS`. Exported as a factory, not read from `config.ts`
 * directly, so this file never has to know which env var that is --
 * `poller.ts` holds no domain logic, and "which setting" is domain logic
 * that belongs to whoever wires this up.
 *
 * `key` -- the literal `MOT_SIRI_KEY` value -- is a REQUIRED parameter, not
 * merely available via a URL this function already had: it is threaded
 * through so `excerpt()` can redact the raw key value wherever it appears
 * in a response body, not only in its own `Key=` URL-parameter form (see
 * `redactLiteralKey`).
 *
 * Reads the body as text FIRST, rather than `res.json()` directly, so a
 * non-2xx response or an unparseable body can carry a diagnostic excerpt
 * instead of throwing the body away -- both `poller.ts:94`'s
 * old `HTTP ${res.status}` and a bare `SyntaxError` from `res.json()` used
 * to say nothing about what the ministry actually sent. Every error this
 * function throws is a `TickError`, carrying both the (excerpt-bearing,
 * log-only) detail and a fixed-vocabulary `publicSummary`.
 */
export function createFetchJson(
  /** `null` for an unauthenticated feed (Stride): there is no key to redact
   *  from a URL or a response body, and every other behaviour is unchanged. */
  timeoutMs: number, key: string | null, opts: CreateFetchJsonOptions = {},
): FetchJson {
  const logger = opts.logger ?? console;
  const maxBytes = opts.maxBytes ?? MAX_SIRI_RESPONSE_BYTES;

  return async (url: string): Promise<unknown> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    // Cheap pre-check when the ministry's own Content-Length is present and
    // honest: rejects before a single body byte is read.
    const declaredLength = res.headers.get("content-length");
    const declaredBytes = declaredLength === null ? null : Number(declaredLength);
    if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      // Reject the body outright, but still release the
      // connection -- an unconsumed, uncancelled response stream would
      // otherwise sit open until GC, on every oversized response this
      // check is specifically meant to catch. The `TickError` is
      // constructed FIRST and `cancel()`'s own rejection is swallowed:
      // `cancel()` running before the `throw`,
      // unguarded, would let a rejected cancel REPLACE the intended
      // `TickError` with a generic one, degrading `/meta`'s `publicSummary`
      // from the correct "response too large" to the catch-all "fetch
      // failed" -- a best-effort cleanup must never be able to override
      // the error it was cleaning up after.
      const tooLarge = new TickError(
        `SIRI response too large: Content-Length ${declaredBytes} exceeds the ${maxBytes}-byte cap`,
        "response too large",
      );
      await res.body?.cancel().catch(() => {});
      throw tooLarge;
    }

    const text = await res.text();
    // Defence in depth for a missing or understated Content-Length: this
    // does not prevent the allocation just above, but it still stops the
    // considerably more expensive `JSON.parse` (and everything downstream
    // of it) from ever running on an oversized body.
    // `Buffer.byteLength(text, "utf8")`, not `text.length` -- the same
    // UTF-16-code-units-vs-bytes confusion fixed one line below for the
    // parse-cost log, missed here: `.length`
    // under-reports a Hebrew-heavy body (this feed's normal content) by
    // roughly a factor of two in the non-ASCII range, which would let the
    // effective cap run to roughly triple the nominal 64 MiB.
    const actualBytes = Buffer.byteLength(text, "utf8");
    if (actualBytes > maxBytes) {
      throw new TickError(
        `SIRI response too large: body is ${actualBytes} bytes, exceeds the ${maxBytes}-byte cap`,
        "response too large",
      );
    }

    if (!res.ok) {
      throw new TickError(`HTTP ${res.status}: ${excerpt(text, key)}`, `HTTP ${res.status}`);
    }

    const parseStart = Date.now();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new TickError(`invalid JSON body: ${excerpt(text, key)}`, "invalid JSON body");
    }
    const parseMs = Date.now() - parseStart;
    // Logged so the size/parse-cost question, otherwise unanswerable in
    // advance, is answerable from a log line instead of from new
    // instrumentation written under pressure the day it turns out to
    // matter. Reuses `actualBytes` (real UTF-8 bytes, computed once above
    // for the size cap) rather than `text.length` (UTF-16 code units,
    // which under-reports a Hebrew-heavy body -- exactly this feed's
    // normal content).
    // `redactKey(url)` alone, NOT the whole composed message: `redactKey`'s
    // own match is greedy up to the next `&` (or end of string) once it
    // finds `Key=`, so redacting a full multi-part log line risks eating
    // every character after the key too whenever the URL happens to be
    // followed by more text and has nothing of its own after `Key=...` to
    // stop at (not a risk for `buildSnapshotUrl`'s own output, which always
    // has `&MonitoringRef=...` right after `Key=`, but not a fact worth
    // depending on at every future call site either).
    logger.info?.(`SIRI fetch ok (${redactKey(url)}): bytes=${actualBytes} parseMs=${parseMs}`);
    return payload;
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * `parseSiriResponse` is deliberately lenient: any shape it does
 * not recognise degrades to zero journeys rather than throwing, so a
 * malformed-but-genuine SIRI response never crashes the poller. That same
 * leniency means a JSON body that is not a SIRI response AT ALL -- a
 * gateway or proxy error page such as `{"message":"quota exceeded"}` --
 * would otherwise parse to something indistinguishable from "legitimately
 * empty country right now", silently wiping the previous good snapshot and
 * reporting `"ok"`. This checks for the one thing every real SIRI response
 * has and an unrelated JSON body does not: the `StopMonitoringDelivery`
 * KEY's presence -- not a non-empty value. An envelope that legitimately
 * carries zero visits (key present, value `[]` or `{}`) stays a valid
 * empty snapshot; only a MISSING key fails the tick.
 */
function hasStopMonitoringDelivery(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const siri = payload["Siri"];
  if (!isRecord(siri)) return false;
  const serviceDelivery = siri["ServiceDelivery"];
  if (!isRecord(serviceDelivery)) return false;
  return "StopMonitoringDelivery" in serviceDelivery;
}

/** The two national snapshot streams this poller runs. Not
 * `SnapshotFilter` from `siri.ts`: this poller never requests `"active"` --
 * only the calls-detail active stream and the planned stream, together
 * covering "the bus you are on" and "the bus you haven't boarded yet". */
export type StreamFilter = "active-calls" | "planned";
const STREAM_FILTERS: readonly StreamFilter[] = ["active-calls", "planned"];

/** One stream's own diagnostics, as `SiriPoller.streamStatuses` reports
 * them -- see that getter's own doc comment. */
export interface StreamStatus {
  lastSuccessAt: number | null;
  failures: number;
  lastError: string | null;
}

/**
 * Identifies "the same underlying trip" across the two streams, for
 * deduping before resolution -- see `SiriPoller.mergedView`'s doc comment.
 * Mirrors the same fields `match.ts`'s natural key uses (route, direction,
 * scheduled origin departure, service date): two journeys agreeing on all
 * four are the same trip as SIRI describes it, whichever stream reported
 * each one.
 */
function journeyIdentity(j: RealtimeJourney): string {
  return `${j.lineRef}|${j.directionId}|${j.originAimedDeparture ?? "?"}|${j.dataFrameRef ?? "?"}`;
}

/**
 * Merges two `RealtimeJourney`s that share one `journeyIdentity` -- i.e.
 * describe the SAME trip -- at the CALL level, not by keeping one of them
 * wholesale. Keeping one wholesale is exactly the bug this replaces: the
 * ICD's documented shape for `AllActiveTripsFilter&calls` is one
 * `MonitoredStopVisit` per trip carrying `MonitoredCall` plus every
 * `OnwardCall`, but `planned` requests `normal` detail, and stop-monitoring's
 * natural shape is one visit PER STOP -- so a real feed can legitimately
 * (or a misbehaving one can accidentally) report the same trip via two
 * separate visits, one per stop, each with only its own `MonitoredCall`.
 * Keeping only the winning journey drops every stop-visit the other one
 * carried and this one does not -- silently, with no error and no log
 * line, since nothing about it looks wrong from the inside.
 *
 * `overlay`'s call for a stop wins whenever both sides cover that stop
 * (same precedence rule as `mergedView`'s identity-level precedence,
 * applied one level finer); a stop only `base` covers survives unchanged.
 * Filtering `base.calls` by `overlay`'s COVERED STOP CODES -- not
 * rebuilding a stopCode -> call map from both arrays -- is deliberate: a
 * loop route can legitimately report the SAME stop code more than once
 * within one journey's own `calls` (`match.ts`'s `resolveCalls` picks the
 * soonest by `order`), and a naive map-based dedup would collapse those
 * down to one entry before `match.ts` ever saw the duplicate to
 * disambiguate. This only removes `base`'s calls for stops `overlay`
 * covers -- but it removes ALL of `base`'s calls for such a stop, not just
 * whichever one collides: `overlay`'s own internal duplicates at a stop
 * survive untouched (nothing filters `overlay.calls`), but if `base` is a
 * loop trip that legitimately visits a stop `overlay` also covers more than
 * once, every one of `base`'s visits to that stop is dropped, not only the
 * single call that would have collided. Narrow, and not expected to fire
 * given the snapshot shapes this poller actually requests, but unconfirmed
 * against the real feed.
 *
 * `overlay`'s other fields (position, vehicleRef, confidence, etc.) become
 * the result's -- the two journeys share every IDENTITY field by
 * definition of the collision, and whichever is being merged in is the
 * more recently observed source for this identity.
 */
function mergeJourneyCalls(base: RealtimeJourney, overlay: RealtimeJourney): RealtimeJourney {
  const overlayStopCodes = new Set(overlay.calls.map((c: RealtimeCall) => c.stopCode));
  const baseOnly = base.calls.filter((c) => !overlayStopCodes.has(c.stopCode));
  return { ...overlay, calls: [...baseOnly, ...overlay.calls] };
}

/** Adds `j` to `byIdentity`, merging it (via `mergeJourneyCalls`, `j` as
 * the higher-precedence `overlay`) into whatever is already there for the
 * same identity rather than overwriting it outright. Used for BOTH
 * cross-stream collisions (`planned` then `active-calls`) and same-stream
 * ones (two visits for one trip within a single fetch) -- either way, the
 * journey being added last always wins its own stops, and nothing already
 * accumulated is discarded wholesale. */
function addOrMergeJourney(byIdentity: Map<string, RealtimeJourney>, j: RealtimeJourney): void {
  const key = journeyIdentity(j);
  const existing = byIdentity.get(key);
  byIdentity.set(key, existing === undefined ? j : mergeJourneyCalls(existing, j));
}

export interface SiriPollerOptions {
  baseUrl: string;
  key: string;
  /** `REALTIME_POLL_SECONDS` -- the `active-calls` stream. */
  pollSeconds: number;
  /** `REALTIME_PLANNED_POLL_SECONDS` -- the `planned` stream. */
  plannedPollSeconds: number;
  /**
   * `REALTIME_MAX_AGE_SECONDS` -- the SAME staleness threshold
   * `RealtimeStore` is built with ("stale is absent"). Needed
   * here too, separately from the store, so a stream whose OWN
   * contribution has gone stale can be evicted from the merge before it
   * pins the combined snapshot's age forever -- see `mergedView`.
   */
  maxAgeSeconds: number;
  store: RealtimeStore;
  /**
   * Resolves a batch of raw SIRI journeys onto the timetable index.
   * Injected rather than computed here because resolution needs
   * `DayContext[]`, which needs `AppBundle.calendar` -- and the
   * file-structure rule keeps `poller.ts` ignorant of both the index and
   * the bundle. Whoever wires this poller up supplies this, closing over
   * the current bundle.
   */
  resolve: (journeys: readonly RealtimeJourney[], fetchedAt: number)
    => { resolved: ResolvedJourney[]; stats: MatchStats; unscheduled?: UnscheduledRun[] };
  fetchJson: FetchJson;
  /** Epoch seconds. Defaults to the wall clock; tests inject a fixed one. */
  now?: () => number;
  logger?: SiriLogger;
  scheduler?: PollerScheduler;
}


/**
 * Polls both SIRI-SM snapshot streams on independent timers and
 * keeps a `RealtimeStore` current. Holds no domain logic: `siri.ts` parses
 * the response, the injected `resolve` (from `match.ts`)
 * matches journeys to trips, `store.ts` holds state -- this file only
 * fetches, wires those two together each tick, and owns timing, backoff
 * and lifecycle.
 */
export class SiriPoller {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly maxAgeSeconds: number;
  private readonly store: RealtimeStore;
  private readonly resolveFn: SiriPollerOptions["resolve"];
  private readonly fetchJson: FetchJson;
  private readonly now: () => number;
  private readonly logger: SiriLogger;
  private readonly streams: readonly [Stream, Stream];
  private lastGood: Record<StreamFilter, { journeys: readonly RealtimeJourney[]; fetchedAt: number } | null> = {
    "active-calls": null,
    planned: null,
  };
  /**
   * Per-stream diagnostics for `/meta`: combined state, age and resolution
   * rate alone are not enough, since `consecutiveFailures` (below) is
   * already a `Math.max` across both
   * streams -- "one dead stream" and "both dead streams" read identically
   * through it. This is the missing per-stream signal: when EACH stream
   * last succeeded, and the redacted text of its most recent failure, if
   * any.
   *
   * Deliberately separate from `lastGood`, which exists for MERGING
   * (`mergedView` evicts a stale entry from it outright -- see that
   * method's own comment) -- `lastSuccessAt` here is a pure diagnostic and
   * must keep reporting the true last-success instant even after
   * `mergedView` has evicted the corresponding `lastGood` entry for being
   * stale, and even after a poll failure (which leaves `lastSuccessAt`
   * untouched, only ever updating `lastError`).
   */
  private streamDiagnostics: Record<StreamFilter, { lastSuccessAt: number | null; lastError: string | null }> = {
    "active-calls": { lastSuccessAt: null, lastError: null },
    planned: { lastSuccessAt: null, lastError: null },
  };
  /**
   * Whether this stream has EVER produced at least one journey, across its
   * whole lifetime (never reset). A stream that regenerates a
   * legitimately-empty envelope for the first
   * time ever is not surprising, but one that has been producing journeys
   * and suddenly produces none is exactly the silent-degradation shape a
   * dropped-visits count alone would miss (e.g. a tick with zero visits at
   * all, rather than visits that parsed and were then dropped).
   */
  private streamEverProducedJourneys: Record<StreamFilter, boolean> = {
    "active-calls": false,
    planned: false,
  };

  constructor(opts: SiriPollerOptions) {
    this.baseUrl = opts.baseUrl;
    this.key = opts.key;
    this.maxAgeSeconds = opts.maxAgeSeconds;
    this.store = opts.store;
    this.resolveFn = opts.resolve;
    this.fetchJson = opts.fetchJson;
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.logger = opts.logger ?? console;
    const scheduler = opts.scheduler ?? REAL_SCHEDULER;

    this.streams = [
      new Stream(pollIntervalMs(opts.pollSeconds), () => this.tick("active-calls"), scheduler),
      new Stream(pollIntervalMs(opts.plannedPollSeconds), () => this.tick("planned"), scheduler),
    ];
  }

  start(): void {
    for (const s of this.streams) s.start();
  }

  stop(): void {
    for (const s of this.streams) s.stop();
  }

  /**
   * The highest number of consecutive failed ticks across both streams,
   * right now -- 0 means every stream's most recent tick succeeded.
   * `store.ts` deliberately performs no I/O and so has no way to tell
   * "still fresh, but every recent poll has failed" apart from a
   * genuinely healthy `"ok"`; a caller that wants to surface that as a
   * `"failing"` health needs it from here instead.
   */
  get consecutiveFailures(): number {
    return Math.max(...this.streams.map((s) => s.failureCount));
  }

  /**
   * Per-stream diagnostics for `/meta`: last success
   * instant, current consecutive-failure count, and the redacted text of
   * the most recent failure -- each keyed separately by `"active-calls"`
   * and `"planned"`, unlike `consecutiveFailures`'s combined `Math.max`.
   * `failures` is read live from `this.streams` (the same counters
   * `consecutiveFailures` uses) rather than duplicated into
   * `streamDiagnostics`, so there is exactly one place that increments or
   * resets a failure count.
   */
  get streamStatuses(): Record<StreamFilter, StreamStatus> {
    const [activeCalls, planned] = this.streams;
    return {
      "active-calls": { ...this.streamDiagnostics["active-calls"], failures: activeCalls.failureCount },
      planned: { ...this.streamDiagnostics.planned, failures: planned.failureCount },
    };
  }

  /**
   * One fetch-parse-resolve-store cycle for one stream. Never throws and
   * never leaves the store half-updated: every failure -- a rejected
   * fetch, a non-JSON body, a JSON body that isn't a SIRI envelope at all,
   * a `SiriError` from an `ErrorCondition`, or the injected resolver
   * throwing -- is caught right here, logged in FULL DETAIL (with the key
   * redacted), and collapsed to a fixed-vocabulary `publicSummary` for
   * `streamDiagnostics` (see the catch block's own comment) -- reported as
   * `false` either way. The store is only ever touched after a resolve
   * that itself did not throw.
   */
  private async tick(filter: StreamFilter): Promise<boolean> {
    // buildSnapshotUrl is pure string assembly over already-validated
    // inputs (siri.ts) and never throws, so `url` is always assigned here,
    // including for the log line in the catch block below.
    const url = buildSnapshotUrl(this.baseUrl, this.key, filter);
    try {
      const payload = await this.fetchJson(url);
      // This MUST run before `hasStopMonitoringDelivery`
      // below. A SERVICE-level SIRI error (`ServiceDelivery.ErrorCondition`,
      // as opposed to the per-delivery one) typically carries no
      // `StopMonitoringDelivery` key at all -- so the envelope gate would
      // otherwise catch it first and report the generic "not a SIRI
      // envelope", discarding the ministry's actual error text. `parseSiriResponse` also
      // checks this internally (so a caller that bypasses `tick` still
      // gets it), but by the time IT would see this payload, the gate
      // below would already have thrown -- checking here, first, is what
      // actually puts it on the path a real tick takes.
      throwOnServiceLevelError(payload);
      if (!hasStopMonitoringDelivery(payload)) {
        // Says something about what the ministry actually sent,
        // rather than nothing -- the top-level shape is LOGGED (field
        // NAMES, redacted -- a field NAME can be the literal key value, so
        // `describePayloadShape` itself redacts it), but never safe for
        // `publicSummary` even so -- see `describePayloadShape`'s own
        // comment.
        throw new TickError(
          `response has no StopMonitoringDelivery -- not a SIRI envelope `
          + `(top-level: ${describePayloadShape(payload, this.key)})`,
          "no StopMonitoringDelivery",
        );
      }
      const snapshot = parseSiriResponse(payload, this.now());

      // A parse that silently drops every visit, or a stream
      // that has gone from producing journeys to producing none, must not
      // read as an ordinary quiet tick.
      if (snapshot.visitsDropped > 0) {
        this.logger.warn(
          `SIRI ${filter}: ${snapshot.journeys.length} journeys from `
          + `${snapshot.visitsSeen} visits (${snapshot.visitsDropped} dropped)`,
        );
      } else if (snapshot.journeys.length === 0 && this.streamEverProducedJourneys[filter]) {
        this.logger.warn(
          `SIRI ${filter}: 0 journeys from ${snapshot.visitsSeen} visits `
          + `(previously produced journeys)`,
        );
      }
      if (snapshot.journeys.length > 0) this.streamEverProducedJourneys[filter] = true;

      this.lastGood[filter] = { journeys: snapshot.journeys, fetchedAt: snapshot.fetchedAt };
      const { journeys, fetchedAt } = this.mergedView();

      const { resolved, stats, unscheduled } = this.resolveFn(journeys, fetchedAt);
      this.store.replace(resolved, stats, fetchedAt, unscheduled ?? []);
      this.streamDiagnostics[filter] = { lastSuccessAt: snapshot.fetchedAt, lastError: null };
      return true;
    } catch (err) {
      // `redactKey(url)` alone, not the whole composed message -- see
      // `createFetchJson`'s own comment on why redacting a full multi-part
      // log line is the riskier order.
      //
      // `redactLiteralKey(errorMessage(err), this.key)` -- NOT `errorMessage(err)`
      // alone -- because a `TickError`'s own body excerpt is not the only
      // unredacted key-shaped text that can reach here: a `SiriError`'s
      // message is
      // `extractErrorText()`, free-form ministry text that never goes
      // through `excerpt()` at all (e.g. an auth-rejection body reading
      // "Invalid API key: <the real key>" -- the single most likely
      // first-contact failure, and the one case this file did not cover).
      // `describePayloadShape` redacts its own output internally now (see
      // its doc comment), but redacting again here costs nothing and does
      // not depend on every future error path remembering to do it itself.
      const detail = redactLiteralKey(errorMessage(err), this.key);
      this.logger.warn(`SIRI ${filter} snapshot failed (${redactKey(url)}): ${detail}`);
      // `lastSuccessAt` is left untouched here, deliberately -- see
      // `streamDiagnostics`'s own doc comment.
      //
      // `lastError` is NEVER `detail`: `detail` can
      // carry a body excerpt or a payload's own field names -- untrusted,
      // third-party text that redaction alone does not make safe to serve
      // on a public endpoint (see `TickError`'s own comment). Only a fixed,
      // author-chosen `publicSummary` reaches `streamDiagnostics`, which
      // `routes/meta.ts` serves as-is:
      //  - a `TickError` (createFetchJson, or the envelope gate above)
      //    supplies its own `publicSummary` ("HTTP 401", "invalid JSON
      //    body", "no StopMonitoringDelivery", "response too large" --
      //    every one of them either a status CODE or a phrase this
      //    codebase wrote, never ministry- or attacker-supplied text);
      //  - a `SiriError` (a legitimate SIRI `ErrorCondition`, service- or
      //    delivery-level) collapses to a fixed "SIRI ErrorCondition" --
      //    its real text is the ministry's own free-form `ErrorText`, which
      //    the log line above still carries in full;
      //  - anything else (a network/timeout failure, a throwing resolver,
      //    or any future error path this file does not yet classify)
      //    collapses to "fetch failed" -- deliberately generic rather than
      //    echoing `err.message`, which could otherwise smuggle a base URL
      //    or hostname through Node's own network-error wording.
      const publicSummary = err instanceof TickError ? err.publicSummary
        : err instanceof SiriError ? "SIRI ErrorCondition"
        : "fetch failed";
      this.streamDiagnostics[filter] = { ...this.streamDiagnostics[filter], lastError: publicSummary };
      return false;
    }
  }

  /**
   * Combines both streams' currently-known journeys into the one batch
   * `resolve()` sees, and the single `fetchedAt` `store.replace()` sees.
   * Only ever called from `tick()`, right after that tick's own fetch
   * succeeded and set `this.lastGood[filter]` for the CURRENT tick's
   * stream -- so at least one entry is always present here.
   *
   * Three bugs a naive "concat whichever stream just ticked, then take
   * Math.min" would have, all fixed here explicitly rather than by relying
   * on incidental ordering elsewhere:
   *
   * 1. PRECEDENCE. A trip can legitimately appear in BOTH streams for a
   *    short window: `planned` covers trips departing within 4h and
   *    regenerates every ~60s, so a trip that has just started stays in
   *    the last `planned` snapshot for up to a minute after
   *    `active-calls` already has live data for it. `active-calls` is
   *    always the more current source for a trip already under way, so it
   *    ALWAYS wins for a shared trip identity (`journeyIdentity`) here --
   *    by construction, never by which array happened to be appended
   *    last, which used to depend on which stream ticked most recently and
   *    would silently serve the stale scheduled time whenever `planned`
   *    ticked after `active-calls`.
   *
   * 2. GRANULARITY. Precedence is applied per STOP, not by keeping one
   *    journey wholesale (`addOrMergeJourney` / `mergeJourneyCalls`). The
   *    documented shape for `AllActiveTripsFilter&calls` is one visit per
   *    trip carrying every call, but that is the ICD, and this feed has
   *    already differed from its own document once (the stop-code join
   *    key -- see `match.ts`). If a
   *    trip is ever reported via more than one visit -- across the two
   *    streams, or even within one -- keeping only the "winning" visit
   *    would silently drop every stop-visit the other one carried and the
   *    winner does not, with no error and no log line.
   *
   * 3. EVICTION. A stream whose OWN contribution has gone stale
   *    (`now - fetchedAt > maxAgeSeconds`) must stop contributing --
   *    to the merged journeys AND to the merged `fetchedAt` -- or a single
   *    dead stream permanently pins the WHOLE merged snapshot's age at its
   *    last success, even while the other stream keeps succeeding on
   *    schedule. Eviction deletes the cached entry outright (not just
   *    skips it this tick), so a stream that never recovers doesn't need
   *    re-checking forever and can't accidentally "un-expire".
   *
   * BOUNDED SELF-HEALING GAP: eviction (point 3) only runs INSIDE a
   * successful tick's call to this method -- there is no independent
   * clock sweeping `lastGood` on its own. So once a stream's contribution
   * crosses `maxAgeSeconds`, it keeps pinning the merged `fetchedAt` (via
   * `Math.min`) at its own stale timestamp for every tick of the OTHER,
   * still-healthy stream that happens BEFORE the crossing is next
   * reassessed -- and it is reassessed on every successful tick of
   * EITHER stream, so the pin lasts at most one poll interval (whichever
   * stream ticks next), not indefinitely. For example: `planned` last
   * succeeded at t=1000, `maxAgeSeconds=180` (crosses stale at t=1180),
   * `active-calls` ticks every 30s and keeps succeeding throughout. Every
   * `active-calls` tick from t=1005 up to and including t=1155 computes
   * `fetchedAt = min(activeCalls.fetchedAt, 1000) = 1000` -- unaffected by
   * how recently `active-calls` itself refreshed, because `planned`'s
   * entry has not crossed the threshold yet at any of those ticks. A
   * `status()` call at, say, t=1183 (after `planned` crossed 1180, before
   * `active-calls`'s next tick at t=1185) sees `age = 183 - 1000 = 183`,
   * reports `"stale"`, and every `predictionFor` answers `null` -- despite
   * `active-calls` having refreshed as recently as t=1155, 28 seconds
   * earlier. The very next tick, at t=1185, reassesses `planned` (now 185s
   * old), evicts it, and `fetchedAt` becomes `active-calls`'s own, current
   * timestamp -- the store is fresh again. This is deliberate, not an
   * oversight: the alternative would be an UNBOUNDED false
   * `"ok"` that never self-heals at all -- a poll-interval-bounded false
   * `"stale"` is the strictly better failure mode.
   */
  private mergedView(): { journeys: readonly RealtimeJourney[]; fetchedAt: number } {
    const now = this.now();
    for (const filter of STREAM_FILTERS) {
      const entry = this.lastGood[filter];
      if (entry !== null && now - entry.fetchedAt > this.maxAgeSeconds) {
        this.lastGood[filter] = null;
      }
    }

    const planned = this.lastGood.planned;
    const active = this.lastGood["active-calls"];

    const byIdentity = new Map<string, RealtimeJourney>();
    // planned first (lower precedence) -- active-calls, added second, wins
    // its own stops over anything planned also reported for the same trip
    // (addOrMergeJourney merges at the call level; see its doc comment and
    // mergeJourneyCalls's). This also merges same-stream duplicates: if
    // EITHER stream itself reports one trip via more than one visit, those
    // collapse together the same way, in whichever order they arrive.
    for (const j of planned?.journeys ?? []) addOrMergeJourney(byIdentity, j);
    for (const j of active?.journeys ?? []) addOrMergeJourney(byIdentity, j);

    const fetchedAts = [active?.fetchedAt, planned?.fetchedAt].filter(
      (t): t is number => t !== undefined,
    );
    // See this method's doc comment: the calling tick's own stream was
    // just set above, and eviction cannot have just removed an entry with
    // age 0, so at least one of the two is always present here.
    const fetchedAt = Math.min(...fetchedAts);

    return { journeys: [...byIdentity.values()], fetchedAt };
  }
}
