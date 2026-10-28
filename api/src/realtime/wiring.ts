import type { TimetableIndex } from "../transit/index.js";
import { buildDayContexts } from "../transit/raptor.js";
import type { CalendarRow } from "../transit/calendar.js";
import type { RealtimeConfig } from "../config.js";
import {
  buildTripLookup, resolveSnapshot, predictFromCalls, predictFromDistance,
  type TripLookup, type ResolvedJourney, type MatchStats, type UnscheduledRun,
} from "./match.js";
import type { RealtimeJourney, RealtimeSource } from "./types.js";
import { RealtimeStore } from "./store.js";
import { StridePoller } from "./stridePoller.js";
import { OpenBusPoller, createFetchSnapshot, type FetchSnapshot } from "./openBusPoller.js";
import {
  SiriPoller, createFetchJson, type FetchJson, type SiriLogger, type PollerScheduler,
} from "./poller.js";

/**
 * The slice of `IndexManager` the realtime resolver needs, narrowed to a
 * structural interface rather than importing `IndexManager` itself -- so a
 * test can supply a plain object with no real database, worker thread, or
 * footpath machinery behind it. A real `IndexManager` satisfies this by
 * construction (structural typing), so production wiring (`index.ts`) can
 * pass one straight through.
 */
export interface ResolverIndexSource {
  current(): TimetableIndex | null;
  currentBundle(): { calendar: readonly CalendarRow[] };
}

export type RealtimeResolver = (
  journeys: readonly RealtimeJourney[], fetchedAt: number,
) => { resolved: ResolvedJourney[]; stats: MatchStats; unscheduled?: UnscheduledRun[] };

/**
 * Builds the `resolve` function `SiriPoller` calls every tick, closed over
 * `source` -- in production the live `IndexManager` -- rather than over one
 * fixed `TimetableIndex`. This ensures the resolver never outlives its
 * bundle: `buildTripLookup(ix)` produces
 * trip INDICES into one specific index, `IndexManager` swaps in a fresh
 * index on every successful `rebuild()` (nightly, or via
 * `POST /admin/reload`), and a lookup built against the OLD index would
 * silently mismatch trip numbers in the new one -- the same trip index can
 * legitimately name an entirely different trip after a swap.
 *
 * Reading `source.current()` INSIDE the returned closure, on every call,
 * rather than capturing one `TimetableIndex` at construction time, is what
 * keeps this current -- the same "getter over the live source, never a
 * captured reference" pattern `server.ts`'s own bundle-derived decorations
 * already use.
 *
 * `buildTripLookup` is a full pass over every trip and stop (see its own
 * doc comment) and pure given `ix`, so it is cached here and only rebuilt
 * when `source.current()`'s REFERENCE changes -- once per feed swap, not
 * once per poll tick (every 15-60s by default).
 */
export function createRealtimeResolver(
  source: ResolverIndexSource, timezone: string, feed: RealtimeSource = "siri-sm",
): RealtimeResolver {
  let cachedIx: TimetableIndex | null = null;
  let cachedLookup: TripLookup | null = null;
  // Chosen once, not per tick: the feed is fixed for the process's life.
  // SIRI-SM reads the ETAs the feed supplies. Both keyless feeds carry
  // positions and no ETAs, so they derive them from the vehicle's distance
  // along the trip -- keyed on "not SIRI-SM" so a future
  // position feed cannot silently get the calls builder and predict nothing.
  const predict = feed === "siri-sm" ? predictFromCalls : predictFromDistance;

  return (journeys, fetchedAt) => {
    const ix = source.current();
    // No index yet (still building at boot, or the live feed symlink is
    // transiently absent -- see IndexManager's own comments): nothing to
    // resolve against. Every journey counts as unresolved rather than being
    // silently dropped and uncounted.
    if (ix === null) {
      return {
        resolved: [],
        unscheduled: [],
        stats: { resolved: 0, unresolved: journeys.length, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0 },
      };
    }

    if (ix !== cachedIx) {
      cachedLookup = buildTripLookup(ix);
      cachedIx = ix;
    }
    // Just (re)built immediately above whenever `ix !== cachedIx` -- which
    // includes the very first call, since `cachedIx` starts `null` and `ix`
    // is never `null` past the guard above -- so `cachedLookup` is always
    // set here for the CURRENT `ix`.
    const lookup = cachedLookup!;

    const calendar = source.currentBundle().calendar;
    const days = buildDayContexts(ix, calendar, new Date(fetchedAt * 1000), timezone);
    // `days` alone is `[today, yesterday]` relative to
    // `fetchedAt` (`buildDayContexts` -> `serviceInstants`'s own fixed
    // shape). The `planned` stream covers trips departing within the next
    // 4 hours, so from roughly 20:00 local onward a trip the ministry
    // frames on TOMORROW's service date (an after-midnight trip, framed
    // GTFS-style on the date its service originates from, e.g. "the 25th"
    // for a run starting 2026-08-25T00:40) would otherwise be silently
    // unresolvable every evening -- nothing in `days` names that date at
    // all, so `selectDay` finds no match and the journey counts only as an
    // anonymous `unresolved`, indistinguishable from an actual mismatch.
    // Nobody knows yet (no key) whether the ministry frames after-midnight
    // trips this way or on the calendar date instead -- this offers the
    // extra day unconditionally so the resolver is not blind to either
    // possibility. One extra `buildDayContexts` call (a `Uint8Array(nTrips)`
    // and a calendar scan) per tick, discarding its own "yesterday" entry
    // (already covered by `days`) and keeping only its "today" entry, which
    // -- relative to `fetchedAt + 24h` -- is exactly "tomorrow" relative to
    // the real `fetchedAt`.
    const tomorrow = buildDayContexts(
      ix, calendar, new Date((fetchedAt + 24 * 3600) * 1000), timezone,
    )[0]!; // buildDayContexts always returns exactly 2 entries; index 0 is always present.
    return resolveSnapshot(lookup, ix, journeys, [tomorrow, ...days], predict);
  };
}

/**
 * Resets `store` to its never-received-anything state (`RealtimeStore.clear()`
 * -- see that method's own doc comment for why a full reset, not merely
 * marking the snapshot stale, is the correct response here). Exists as its
 * own named function, rather than inlining `store.clear()` at the one call
 * site, purely to carry the WHY at the point of use: called synchronously
 * from `IndexManager`'s `onIndexSwap` hook (via `createRealtimeRuntime`
 * below), in the SAME synchronous stretch of the event loop as the index
 * swap itself (see manager.ts's own comment on that hook) -- there is no
 * window in which a request can read a `tripIdx` computed against the NEW
 * index while this store still answers with a `ResolvedJourney` resolved
 * against the superseded one. The next successful poll tick repopulates it
 * with real data resolved against the new index, via a freshly rebuilt
 * `TripLookup` (see `createRealtimeResolver`).
 */
export function invalidateForIndexSwap(store: RealtimeStore): void {
  store.clear();
}

export interface RealtimeRuntimeDeps {
  fetchJson?: FetchJson;
  /** The open-bus poller's snapshot download; defaults to the real one. */
  fetchSnapshot?: FetchSnapshot;
  logger?: SiriLogger;
  now?: () => number;
  scheduler?: PollerScheduler;
}

export interface RealtimeRuntime {
  /** `null` when realtime is disabled -- the normal state. Decorate onto
   *  `app.realtime` as-is. */
  store: RealtimeStore | null;
  /** `null` when realtime is disabled. Constructed but never started here
   *  -- the caller (`index.ts`) decides when to call `.start()`/`.stop()`,
   *  so building this runtime never arms a timer by itself. */
  poller: SiriPoller | OpenBusPoller | StridePoller | null;
  /**
   * `undefined` when realtime is disabled -- nothing to invalidate. When
   * present, the caller MUST wire it into the SAME `IndexManager` that
   * `index` (passed to this function) reads from, via
   * `IndexManager.setOnIndexSwap`, before that manager's next `rebuild()`
   * completes -- otherwise a feed swap would leave `store` holding
   * predictions resolved against the superseded index (see
   * `invalidateForIndexSwap`'s own comment).
   */
  onIndexSwap: ((index: TimetableIndex) => void) | undefined;
}

/**
 * The single composition root for realtime: given `cfg` (the realtime
 * settings, as `resolveRealtimeConfig` produces them) and a live index
 * source, either builds nothing at all (disabled) or builds the store, the
 * poller (closed over a resolver reading `index` fresh on every tick), and
 * the swap-invalidation hook, ALL THREE consistently wired to each other.
 *
 * This exists specifically so the connection between "no key configured"
 * and "no poller, no timer, no swap hook" is a property of ONE function a
 * test can call directly -- `index.ts` is a side-effecting entrypoint
 * script (it calls `app.listen`, installs signal handlers, etc.) that no
 * test can import, so before this function existed, that connection was
 * two untested ternaries living only there. `index.ts` now does nothing
 * but destructure this result, wire `onIndexSwap` into its `IndexManager`,
 * pass `store`/`poller` into `buildServer`, and call `.start()`/`.stop()`
 * at the appropriate lifecycle points -- pure assembly, no decisions.
 */
export function createRealtimeRuntime(
  cfg: RealtimeConfig, index: ResolverIndexSource, timezone: string, deps: RealtimeRuntimeDeps = {},
): RealtimeRuntime {
  if (!cfg.enabled || cfg.source === null) {
    return { store: null, poller: null, onIndexSwap: undefined };
  }

  const store = new RealtimeStore(cfg.source, cfg.maxAgeSeconds, deps.now);
  const resolve = createRealtimeResolver(index, timezone, cfg.source);

  if (cfg.source === "open-bus-vm") {
    // Set together with the source by resolveRealtimeConfig, never apart.
    const openBus = cfg.openBus!;
    const openBusPoller = new OpenBusPoller({
      baseUrl: openBus.baseUrl,
      pollSeconds: openBus.pollSeconds,
      maxVehicleAgeSeconds: openBus.maxVehicleAgeSeconds,
      store,
      resolve,
      // Unauthenticated, like Stride: no key to redact.
      fetchJson: deps.fetchJson ?? createFetchJson(cfg.timeoutMs, null, { logger: deps.logger }),
      fetchSnapshot: deps.fetchSnapshot ?? createFetchSnapshot(cfg.timeoutMs),
      now: deps.now,
      logger: deps.logger,
      scheduler: deps.scheduler,
    });
    return { store, poller: openBusPoller, onIndexSwap: () => invalidateForIndexSwap(store) };
  }

  if (cfg.source === "stride-vm") {
    // `cfg.source === "stride-vm"` guarantees `cfg.stride` is non-null --
    // resolveRealtimeConfig sets the two together, and neither without the
    // other.
    const stride = cfg.stride!;
    const stridePoller = new StridePoller({
      baseUrl: stride.baseUrl,
      pollSeconds: stride.pollSeconds,
      maxVehicleAgeSeconds: stride.maxVehicleAgeSeconds,
      pageLimit: stride.pageLimit,
      maxPages: stride.maxPages,
      bbox: {
        minLat: stride.minLat, maxLat: stride.maxLat,
        minLon: stride.minLon, maxLon: stride.maxLon,
      },
      store,
      resolve,
      // `null` key: Stride is unauthenticated, so there is nothing to redact
      // from a URL or a response body. The timeout and size cap still apply.
      fetchJson: deps.fetchJson ?? createFetchJson(cfg.timeoutMs, null, { logger: deps.logger }),
      now: deps.now,
      logger: deps.logger,
      scheduler: deps.scheduler,
    });
    return { store, poller: stridePoller, onIndexSwap: () => invalidateForIndexSwap(store) };
  }

  const poller = new SiriPoller({
    // `cfg.enabled` guarantees both are non-null -- see resolveRealtimeConfig.
    baseUrl: cfg.baseUrl!,
    key: cfg.key!,
    pollSeconds: cfg.pollSeconds,
    plannedPollSeconds: cfg.plannedPollSeconds,
    maxAgeSeconds: cfg.maxAgeSeconds,
    store,
    resolve,
    // `cfg.enabled` guarantees `cfg.key` is non-null (same invariant as
    // `key: cfg.key!` above) -- `createFetchJson` needs the literal value,
    // not just the URL it's embedded in, so it can redact the raw key from
    // a response body too (see `redactLiteralKey`).
    fetchJson: deps.fetchJson ?? createFetchJson(cfg.timeoutMs, cfg.key!, { logger: deps.logger }),
    now: deps.now,
    logger: deps.logger,
    scheduler: deps.scheduler,
  });
  return { store, poller, onIndexSwap: () => invalidateForIndexSwap(store) };
}
