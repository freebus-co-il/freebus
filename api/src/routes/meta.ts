import type { FastifyPluginAsync } from "fastify";
import { serviceWindow } from "../transit/calendar.js";
import { ApiError } from "../errors.js";
import type { RealtimeStatus, RealtimeStore } from "../realtime/store.js";
import { lastShiftStats } from "../transit/shift.js";
import type { StreamFilter, StreamStatus } from "../realtime/poller.js";

/** `RealtimeStatus` plus per-stream diagnostics.
 * `StreamStatus.lastError` is already redacted at the point `SiriPoller`
 * records it (see poller.ts's `tick`), so nothing here needs to redact it
 * again -- this is purely composition, never a place new key-shaped data
 * could enter the response. */
interface RealtimeMetaStatus extends RealtimeStatus {
  streams: Record<StreamFilter, StreamStatus>;
  /**
   * What the most recent delay-shifted timetable build produced -- `null`
   * until the first `/plan` of a snapshot builds one (see
   * `transit/shift.ts`'s `shiftsFor`), which is why this is reported rather
   * than computed here: building one costs ~124 ms and belongs to `/plan`.
   *
   * `conflictingPatterns` is the field worth an alert. It is 0 on this feed
   * under ordinary conditions; a number that climbs means live re-planning is
   * silently falling back to the timetable for that slice of the network.
   */
  shift: { delayedTrips: number; conflictingPatterns: number } | null;
}

/**
 * Folds the poller's own tick outcomes into the store's I/O-blind health.
 * `RealtimeStore.status()` can only ever
 * report `disabled`/`ok`/`stale` -- it never performs I/O and so has no way
 * to know whether the CURRENT poll is actually succeeding, only how old its
 * last successful one is. `consecutiveFailures` (the max across both
 * streams -- see `poller.ts`) is the missing signal, and it OVERRIDES the
 * store's own health -- even "ok" -- the instant it is nonzero: an "ok"
 * status only means the last GOOD snapshot is still within
 * `REALTIME_MAX_AGE_SECONDS`, it says nothing about whether the feed is
 * CURRENTLY reachable. A stream that just started failing, but has not yet
 * pushed the merged snapshot past staleness, is exactly the silent
 * degradation this exists to catch -- reporting "ok" through it would
 * defeat the entire point of a dedicated "failing" state.
 *
 * Two consequences of that choice, both accepted deliberately (erring
 * toward a visible false alarm is right for a signal whose entire job is
 * catching silent degradation):
 *  - a SINGLE transient timeout pins `"failing"` for at least one backed-off
 *    poll interval, even while the merged snapshot the store is answering
 *    from is perfectly fresh (the other stream is still succeeding);
 *  - `consecutiveFailures` is the MAX across both streams (poller.ts), so
 *    one dead stream and both dead streams read IDENTICALLY here -- this
 *    block cannot by itself tell an operator which failure mode they have,
 *    only that at least one stream needs attention.
 *
 * `store === null` (no `MOT_SIRI_KEY`/`MOT_SIRI_BASE_URL` configured at
 * all) is never overridden: there is no poller that could have failed, and
 * that is the one case this block must always report as `"disabled"`.
 */
function realtimeStatus(
  store: RealtimeStore | null, consecutiveFailures: number, now: number,
  streams: Record<StreamFilter, StreamStatus>,
): RealtimeMetaStatus {
  if (store === null) {
    return {
      // No store means no source was ever chosen -- realtime is off, as
      // opposed to configured-but-silent, which reports its own source.
      health: "disabled", source: null, ageSeconds: null, journeys: 0, resolved: 0,
      unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0, streams,
      shift: null,
    };
  }
  const raw = store.status(now);
  // A CONFIGURED store that has never (yet) produced a usable snapshot --
  // at boot, before the first poll succeeds (index.ts deliberately starts
  // listening before the first index build, and the realtime poller starts
  // even later, alongside it), or right after an index swap
  // (`RealtimeStore.clear()`, via `wiring.ts`'s `invalidateForIndexSwap`) --
  // reports `"disabled"` from `store.ts`'s own narrow vocabulary: it only
  // distinguishes "never got anything" from "got something, now stale", not
  // "never configured" from "configured but still warming up". Left
  // unmapped, both cases would render identically here, which is exactly
  // the confusion this health block exists to prevent -- an operator with a
  // correctly configured key would see the same string as one who forgot
  // it. Remapped to `"stale"`: the deployment IS configured (`store` is
  // non-null here), there is just nothing usable RIGHT NOW, which is what
  // `"stale"` already means everywhere else in this enum. `ageSeconds` stays
  // `null` in this remapped state -- there has never been a real fetch to
  // measure an age from.
  const shift = lastShiftStats();
  const status: RealtimeMetaStatus = raw.health === "disabled"
    ? { ...raw, health: "stale", streams, shift }
    : { ...raw, streams, shift };
  return consecutiveFailures > 0 ? { ...status, health: "failing" } : status;
}

export const metaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/meta", async () => {
    const window = serviceWindow(app.calendar);
    return {
      version: app.db.version,
      fetchedAt: app.db.fetchedAt,
      counts: app.db.counts,
      serviceWindow: { start: window.start, end: window.end },
      index: {
        state: app.index.state(),
        version: app.index.current()?.version ?? null,
        footpaths: app.index.footpathMode(),
      },
      // Never the key, never the base URL -- only counts and health.
      // `app.realtime`/`app.realtimeConsecutiveFailures`/
      // `app.realtimeStreamStatuses` are the ONLY realtime-related
      // decorations this route ever reads.
      realtime: realtimeStatus(
        app.realtime, app.realtimeConsecutiveFailures, Date.now() / 1000, app.realtimeStreamStatuses,
      ),
      timezone: app.transitTimezone,
    };
  });

  // Distinct from /health: the process is alive but cannot answer a data
  // question until an index exists. A load balancer needs both signals.
  app.get("/ready", async () => {
    if (app.index.current() === null) {
      // The 200 below is a SUCCESS body and keeps its own `{ready, state}`
      // shape; the 503 is an ERROR and uses the one shared envelope, so a
      // client parsing failures does not need a special case for this route.
      // `ready: false` is not lost -- a 503 from /ready means exactly that,
      // and `state` is carried in `details`.
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }
    return { ready: true, state: app.index.state() };
  });
};
