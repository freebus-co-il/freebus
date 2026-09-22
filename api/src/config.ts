import { fileURLToPath } from "node:url";
import type { RealtimeSource } from "./realtime/types.js";
import { dirname, resolve } from "node:path";

/**
 * `Number`, not `Number.parseInt`. `parseInt` stops at the first character it
 * cannot use and returns what it has: `Number.parseInt("6O000", 10)` is 6.
 * `Number` gives NaN for the same string, which this rejects by name.
 *
 * `env` defaults to the real `process.env`, so every existing call site
 * (which all omit it) is unaffected; `resolveRealtimeConfig` below passes
 * its own `env` parameter through explicitly, so a test can exercise its
 * numeric settings too, not just `key`/`baseUrl`/`enabled`.
 */
function intEnv(
  name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

/**
 * `intEnv`'s fractional sibling, for weights and shares that are genuinely not
 * integers. Same `Number`-not-`parseInt` reasoning as `intEnv` above, and the
 * same fail-at-boot contract.
 *
 * `Number.isFinite` rather than `!Number.isNaN`: `Number("Infinity")` is a
 * perfectly good number that would pass a NaN check and then silently make
 * every cost comparison in `transit/rank.ts` meaningless. `Number("")` is 0,
 * which the range check catches for every key this is used with.
 *
 * Exported so `config.test.ts` can exercise the validation directly, exactly
 * as it is the only way to test the boot-time failure without a subprocess.
 */
export function floatEnv(
  name: string, fallback: number, min: number, max: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

/**
 * Fails at boot on anything that is not a real IANA zone name.
 *
 * This value decides where every service-day boundary falls and what offset
 * every ISO timestamp is rendered with, so a typo in it does not produce an
 * error anywhere — it produces a service that is quietly wrong by hours,
 * everywhere, forever. `Intl.DateTimeFormat` already carries the full zone
 * database, so constructing one and catching the RangeError is a complete
 * check with no dependency and no table to maintain.
 *
 * NOTE, and this is a real hazard the check cannot cover: this piggybacks on
 * the POSIX `TZ` variable, which container runtimes, CI images and
 * schedulers set for their own reasons. `TZ=UTC` is a perfectly VALID zone,
 * so it passes this validation while moving every service-day boundary three
 * hours. If service days ever come out wrong on a new platform, look here
 * first and check what the platform set `TZ` to.
 */
function ianaZone(name: string, value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(
      `Invalid ${name}: ${value} (must be an IANA time zone name, e.g. Asia/Jerusalem)`,
    );
  }
  return value;
}

const port = intEnv("PORT", 3100, 1, 65535);

export const config = {
  port,
  host: process.env.HOST ?? "0.0.0.0",
  env: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
  timezone: ianaZone("TZ", process.env.TZ ?? "Asia/Jerusalem"),
  /**
   * Shared secret gating `POST /admin/reload`, the one mutating endpoint on
   * an otherwise read-only, permissively-CORS'd public server. That endpoint
   * starts a multi-hundred-megabyte index rebuild, so an anonymous caller
   * able to reach it could hold one running continuously.
   *
   * `null` (the variable unset) means the route REFUSES EVERY REQUEST — it
   * does not mean "no auth configured, let everyone in". Failing closed is
   * the only safe default: an operator who forgets the variable gets a
   * reload endpoint that does not work, which they will notice, rather than
   * one anyone on the internet can drive, which they will not.
   *
   * Deliberately NOT validated for length or shape here: any non-empty
   * string the operator chose is their business, and rejecting a "weak" one
   * at boot would take the whole service down over the one endpoint it gates.
   */
  adminToken: process.env.TRANSIT_ADMIN_TOKEN === undefined
    || process.env.TRANSIT_ADMIN_TOKEN === ""
    ? null
    : process.env.TRANSIT_ADMIN_TOKEN,
} as const;

export const isProduction = config.env === "production";

/**
 * Anchored on this module's own location, not process.cwd(). `src/config.ts`
 * (dev, via tsx) and `dist/config.js` (production) are both exactly one level
 * below `api/`, itself one level below the repo root — so the same
 * two-hop reaches the repo root from either. The data directory is shared
 * with gtfs, which resolves it the same way; a cwd-relative default
 * would have the two services disagree about where the database lives the
 * moment either was launched from somewhere unexpected.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..");

export const paths = {
  dataDir: process.env.GTFS_DATA_DIR === undefined
    ? resolve(repoRoot, "data")
    : resolve(repoRoot, process.env.GTFS_DATA_DIR),
  // Deliberately not inside data/ — gtfs garbage-collects that
  // directory and must never encounter our cache files there.
  cacheDir: process.env.TRANSIT_CACHE_DIR === undefined
    ? resolve(repoRoot, "cache")
    : resolve(repoRoot, process.env.TRANSIT_CACHE_DIR),
} as const;

export const reloadPollMs = intEnv("TRANSIT_RELOAD_POLL_MS", 60_000, 1_000, 3_600_000);

export const valhallaConfig = {
  url: process.env.VALHALLA_URL ?? "http://localhost:8002",
  timeoutMs: intEnv("VALHALLA_TIMEOUT_MS", 5_000, 1, 600_000),
  batchSize: intEnv("VALHALLA_BATCH_SIZE", 50, 1, 500),
} as const;

export type GeocoderBackend = "photon" | "google";

export interface GeocoderConfig {
  backend: GeocoderBackend;
  photon: { url: string; timeoutMs: number };
  /** Present exactly when `backend === "google"`. */
  google: { apiKey: string; timeoutMs: number; dailyRequestLimit: number } | null;
}

/**
 * `GEOCODER` picks who answers `/geocode/*`: self-hosted Photon (free, but
 * OSM is missing most businesses and many addresses) or Google Maps (metered
 * -- see `geocode/google.ts` for what that costs and how it is kept down).
 *
 * Unlike realtime, a bad value here THROWS rather than warning: `GEOCODER=
 * google` with no key would silently turn address search off for every rider,
 * and a typo'd backend name would do the same. `deploy.sh` checks the key
 * before it restarts anything, so this is the second line, not the first.
 *
 * Defaults to photon so a dev checkout with no key keeps working.
 */
export function resolveGeocoderConfig(env: NodeJS.ProcessEnv): GeocoderConfig {
  const backend = emptyToNull(env.GEOCODER) ?? "photon";
  if (backend !== "photon" && backend !== "google") {
    throw new Error(`Invalid GEOCODER: ${backend} (must be "photon" or "google")`);
  }
  const apiKey = emptyToNull(env.GOOGLE_MAPS_API_KEY);
  if (backend === "google" && apiKey === null) {
    throw new Error("GEOCODER=google requires GOOGLE_MAPS_API_KEY");
  }
  return {
    backend,
    photon: {
      url: env.PHOTON_URL ?? "http://localhost:2322",
      timeoutMs: intEnv("PHOTON_TIMEOUT_MS", 5_000, 1, 600_000, env),
    },
    google: backend === "google" ? {
      apiKey: apiKey!,
      timeoutMs: intEnv("GOOGLE_MAPS_TIMEOUT_MS", 3_000, 1, 600_000, env),
      // Every billable call counts: autocomplete, place details, reverse.
      // 0 turns the ceiling off.
      dailyRequestLimit: intEnv("GOOGLE_MAPS_DAILY_REQUEST_LIMIT", 3_000, 0, 10_000_000, env),
    } : null,
  };
}

export const geocoderConfig = resolveGeocoderConfig(process.env);

export const planConfig = {
  /**
   * How many of a `/plan` response's itineraries get the departure
   * REOPTIMISATION pass (the second reverse RAPTOR search per itinerary, see
   * `routes/reoptimise.ts`). Every itinerary beyond this is still RE-ANCHORED
   * on its own first boarding, so no itinerary ever regresses to reporting
   * the query instant — only the "can we leave even later for the same
   * arrival?" refinement is skipped.
   *
   * 3, measured rather than assumed. Cost is linear in the number of Pareto
   * members actually RETURNED (not in `results`, which is only a cap), and
   * superlinear per member because each later member is a higher round and so
   * a longer reverse search. Measured warm against the live feed, 15
   * iterations, median end-to-end latency by Pareto members returned
   * (2026-08-23, Dimona -> Netanya, `maxTransfers=6&maxWalkMeters=2500` — the
   * largest Pareto set found over a 16x16 sweep of long routes):
   *
   *   | members | 1   | 2   | 3   | 4   | 5   | 6   |
   *   | ms      | 107 | 136 | 206 | 321 | 453 | 590 |
   *
   * At the time (2026-08-23), the standing target was a flat 250 ms.
   * Unbounded, the default `results=5` blows through it on any long route
   * with four or more members: 273 ms Tel Aviv -> Haifa, 453 ms Dimona ->
   * Netanya. Bounded at 3 both land at ~200 ms. That flat number was later
   * replaced by one that scales with Pareto members returned -- see the
   * REVISED TARGET note at the end of this comment.
   *
   * Which members keep their reoptimisation is decided by `paretoRounds`'s
   * own fewest-transfers-first push order INSIDE each `search()` call, before
   * effort ranking ever runs (`reoptimise.ts`'s `reoptimiseBounded`, called
   * from `routes/plan.ts`) — not by the position ranking later gives an
   * itinerary in the `/plan` response. Before effort ranking existed those
   * were the same thing; they no longer are, since ranking both reorders and
   * filters the merged result of every `search()` call after every one of
   * them has already applied this bound. A candidate left past this limit at
   * search time can still rank first in the response a rider sees, and it is
   * exactly that candidate — the one that skipped the "could the traveller
   * leave even later for this same arrival?" refinement — that ends up on
   * top. Re-anchoring is unaffected: it stays unconditional either way, so no
   * itinerary ever regresses to reporting the query instant regardless of
   * where ranking puts it. The bound is still applied at search time, per
   * `search()` call, for the cost reason measured above — only the claim
   * about WHICH members that protects has changed.
   *
   * 0 disables reoptimisation entirely, leaving re-anchoring in place.
   *
   * RE-MEASURED 2026-08-25, after the effort-ranking feature landed, which
   * added one mandatory extra reverse RAPTOR pass per `departAfter` request
   * (`PLAN_REVERSE_PROBES`, minimum 1 -- it cannot be switched off), to
   * check whether lowering this bound could pay for that new pass. Same
   * method as above -- warm (5 untimed warm-up requests, not one:
   * one request left V8/JIT and the OS page cache for `gtfs.sqlite` visibly
   * unsettled), 15 iterations, median/p90 end-to-end latency by Pareto members
   * returned, live feed, `PLAN_REVERSE_PROBES=1`, `maxTransfers=6&
   * maxWalkMeters=2500`, own server instance on a spare port so as not to
   * disturb the one already serving traffic. Two routes, swept across every
   * value of this bound:
   *
   * STANDING CAVEAT, over every figure in this file, this table included:
   * all of it -- the pre-feature table above and this sweep both -- was
   * measured on a shared personal dev laptop, not the deployment target.
   * The deployment target is a box with 2 shared ARM vCPUs and 4 GB RAM,
   * which is plausibly SLOWER than this laptop, not faster -- so read every
   * millisecond figure here as optimistic, not conservative, until
   * re-measured on that box itself.
   *
   *   | route              | members | REOPT=3      | REOPT=2      | REOPT=1      | REOPT=0             |
   *   | ------------------- | ------- | ------------ | ------------ | ------------ | ------------------- |
   *   | Tel Aviv -> Haifa   | 2       | 246 / 250 ms | 251 / 257 ms | 250 / 274 ms | 243 / 247 ms        |
   *   | Dimona -> Netanya   | 5       | 471 / 496 ms | 368 / 400 ms | 331 / 364 ms | 317-324 / 328-333 ms |
   *
   *   (p50 / p90 each cell.) Tel Aviv -> Haifa's REOPT=2/REOPT=1 p90 (257 ms,
   *   274 ms) reads WORSE than REOPT=3's despite doing strictly less work --
   *   that is tail noise from a shared, busy laptop (load average climbed from
   *   ~3.4 to ~4.6 over the course of this sweep), not a real effect; a
   *   2-member route's cost cannot depend on a bound of 2 or 3 since both
   *   cover every member it has.
   *
   * This reproduced the feature-on baseline the plan's controller measured
   * first (252/258 ms and 468/482 ms for the same two routes at REOPT=3) to
   * within a few percent, confirming the harness before trusting the sweep
   * built on it.
   *
   * The bound clearly pays for the new pass and then some: Dimona -> Netanya
   * drops 471 -> 324 ms (31%) from REOPT=3 to REOPT=0, and the drop is
   * front-loaded -- REOPT 3->2 alone saves ~103 ms, 2->1 another ~37 ms, 1->0
   * only ~7 ms more. That is exactly the "superlinear per member" shape the
   * paragraph above predicts: `reoptimiseBounded` reoptimises the FIRST
   * itineraries in `paretoRounds`'s fewest-transfers-first push order, so
   * turning the bound down first drops the highest-round (most expensive)
   * member still covered, not the cheapest.
   *
   * BUT: at REOPT=0 -- reoptimisation fully OFF, nothing left to trade away --
   * Dimona -> Netanya still costs 317-324 ms p50 / 328-333 ms p90 (re-run
   * once to check the finding; range reported rather than picking one),
   * over the flat 250 ms threshold this file cited at the time -- see the
   * REVISED TARGET note at the end of this comment for what replaced it.
   * This is a genuine long-tail case, not a
   * regression this feature introduced (the pre-feature table above already
   * shows 453 ms, unbounded, for a 5-member Dimona -> Netanya query, and this
   * knob was the ONLY thing keeping typical queries near 200 ms before this
   * feature existed too) -- but it means THIS KNOB ALONE cannot close the gap
   * for every route, no matter how far down it goes. Tel Aviv -> Haifa (2
   * members) cleared the then-flat 250 ms at every value tested; Dimona ->
   * Netanya (5 members) cleared it at none.
   *
   * Cost of turning this down, measured (not assumed): for a sample of 10
   * real OD pairs across the network (`maxTransfers=6&maxWalkMeters=2500`,
   * `results=10`, same fixed `departAfter`), comparing REOPT=3 against
   * REOPT=0 by matching itineraries on (transfers, arrivalTime) -- the same
   * definition `reoptimiseItinerary` itself uses for "the same itinerary" --
   * 8 of 26 returned itineraries reported an earlier `departureTime` (and a
   * correspondingly longer `durationSeconds`, for the same real ride) with
   * reoptimisation off: deltas from 0.2 to 30.0 minutes, mean 11.4 minutes.
   * Going only to REOPT=1 instead of REOPT=0 on the same sample changes just
   * 3 of 26 (the ones sitting exactly at position 2, the one this bound stops
   * covering first), all in the 6.9-16.6 minute range -- REOPT=1 keeps ~95%
   * of the REOPT=0 latency saving on Dimona -> Netanya (140 of 147 ms) while
   * giving up much less accuracy than REOPT=0 does. If this bound is ever
   * lowered, 1 is the better trade than 0, not a compromise between them.
   *
   * DECISION: the default stays 3. This re-measurement does not change it,
   * and deliberately does not silently relax the then-standing 250 ms
   * threshold to declare a lower value "compliant" -- Dimona -> Netanya
   * breached it at every value from 3 down to 0, so no choice of this knob
   * alone satisfied that flat number for every route. That the breach
   * predates this feature (see the unbounded pre-feature table above) does
   * not make it acceptable to ship past un-remarked; it means the fix, if
   * there is to be one, is not something this knob alone can provide. The
   * full sweep and quantification are the measurement above; this breach
   * was escalated rather than papered over.
   *
   * REVISED TARGET, 2026-08-25 (second pass, after the re-measurement
   * above): the flat 250 ms figure this comment cited throughout was never
   * this feature's own -- it was inherited, uncredited, from a DIFFERENT,
   * earlier geometry design and restated here as if it were live. It is
   * replaced with a target that SCALES with the number of Pareto members a
   * response returns, `T(members) = 100 + 75 * members` ms (p50), fit to
   * this exact sweep's own REOPT=3 points (246 ms at 2 members, 471 ms at 5
   * members) -- a dev-laptop-derived working target, not a validated
   * production SLO.
   */
  reoptimiseMaxItineraries:
    intEnv("PLAN_REOPTIMISE_MAX_ITINERARIES", 3, 0, 10),
} as const;

/**
 * Per-route rate limits, one entry per RAPTOR-backed endpoint, layered on
 * top of (not instead of) the global `{ max: 300, timeWindow: "1 minute" }`
 * limit `server.ts` registers for the whole API. The global limit protects
 * the server generally; each entry here protects ONE expensive endpoint
 * specifically -- `/plan`, `/journey/check`, `/plan/onboard` and `/segments`
 * all run a search over the in-memory RAPTOR index per request, by a wide
 * margin the most expensive thing this box does, so each gets its own
 * budget rather than sharing one pool with a `/stops` or `/meta` lookup
 * that costs almost nothing.
 *
 * `@fastify/rate-limit` keys every one of these on `request.ip` -- PER
 * CLIENT IP, not per device or per rider. Israeli mobile carriers put many
 * subscribers behind one carrier-grade NAT address, so one IP here can be
 * dozens of real riders sharing a budget meant for one. An operator who
 * sees 429s from genuine users should RAISE the relevant value, not remove
 * the limit -- carrier NAT only gets denser, not sparser.
 */
export const routeRateLimits = {
  /**
   * Per-route ceiling on `GET /plan` specifically. `/plan` runs a RAPTOR
   * search per request -- by a wide margin the most expensive thing this
   * box does per request.
   *
   * The default follows from how the app itself polls: a results screen
   * left open re-fetches `/plan` once a minute
   * (`PLAN_REFETCH_INTERVAL_MS` in `app/src/api/plan.ts`), so 60/min is
   * roughly 60 concurrent watchers behind a single carrier address, not 60
   * requests from one person.
   */
  planPerMinute: intEnv("PLAN_RATE_LIMIT_PER_MINUTE", 60, 1, 10_000),

  /**
   * Per-route ceiling on `GET /journey/check`. This route is POLLED, not
   * event-driven: the app re-checks an active journey every 30 s
   * (`JOURNEY_CHECK_POLL_MS` in `app/src/features/journey/use-journey-live.
   * ts`), i.e. 2 requests/minute for one rider watching one journey. 120 is
   * therefore roughly 60 concurrent journeys behind one carrier-grade NAT
   * address, matching `/plan`'s own concurrent-watcher reasoning above.
   *
   * This route serves a rider MID-JOURNEY -- a 429 here breaks the
   * connection-holds check for someone actually travelling right now, not
   * someone idly re-browsing results. That is why the ceiling is set
   * generously, and why raising it (not removing it) is the correct
   * response to real-rider 429s.
   */
  journeyCheckPerMinute: intEnv("JOURNEY_CHECK_RATE_LIMIT_PER_MINUTE", 120, 1, 10_000),

  /**
   * Per-route ceiling on `GET /plan/onboard`. EVENT-DRIVEN, not polled --
   * the frontend calls this once when the rider asks to re-plan from the
   * vehicle they are already aboard, not on a timer -- and it runs the same
   * shape of search as `/plan` (a RAPTOR search per request), so it gets
   * the same budget as `/plan` rather than a tighter or looser one.
   *
   * Like `/journey/check`, this route serves a rider MID-JOURNEY -- they
   * are already aboard a vehicle and re-planning from it -- so a 429 here
   * breaks something someone is relying on while travelling. The ceiling is
   * set generously for that reason, and raising it is the correct response
   * to real-rider 429s, not removing it.
   */
  planOnboardPerMinute: intEnv("PLAN_ONBOARD_RATE_LIMIT_PER_MINUTE", 60, 1, 10_000),

  /**
   * Per-route ceiling on `GET /segments`. USER-INITIATED (a rider expands a
   * transit leg to see its alternatives) rather than polled or a
   * background re-plan, and -- per `api/README.md` -- a LOOKUP over the
   * in-memory RAPTOR index (no headway margin, no reachability search), not
   * a re-plan like `/plan` or `/plan/onboard`. Cheaper per request than
   * either of those, so it can afford a higher ceiling than `/plan` while
   * still sitting well below the global limit.
   */
  segmentsPerMinute: intEnv("SEGMENTS_RATE_LIMIT_PER_MINUTE", 120, 1, 10_000),
} as const;

/**
 * How `/plan` and `/plan/onboard` order what they found. Structurally a
 * `transit/rank.ts` `RankConfig`, plus the probe count, which only
 * `routes/plan.ts` reads.
 *
 * `PLAN_WALK_WEIGHT=1` with `PLAN_TRANSFER_PENALTY_SECONDS=0` collapses
 * `journeyCost` to `durationSeconds`, restoring duration ordering exactly. Be
 * precise about what that is and is not: it is a COST-FUNCTION off switch, not
 * a FEATURE off switch. The extra reverse pass still runs and the filters
 * still apply, so results are not byte-identical to the pre-feature planner --
 * unlike `TRANSFER_HEADWAY_FACTOR=0`, which genuinely is.
 *
 * There is deliberately no off switch for the walk-only drop. A route that
 * only walks the whole way is a defect, and defects do not get a way to
 * stay on.
 */
export const rankConfig = {
  walkWeight: floatEnv("PLAN_WALK_WEIGHT", 2.0, 1.0, 5.0),
  transferPenaltySeconds: intEnv("PLAN_TRANSFER_PENALTY_SECONDS", 300, 0, 3_600),
  departureWindowSeconds: intEnv("PLAN_DEPARTURE_WINDOW_SECONDS", 1_800, 0, 21_600),
  maxWalkShare: floatEnv("PLAN_MAX_WALK_SHARE", 0.7, 0, 1),
  /**
   * How many reverse probes the `departAfter` branch runs,
   * at evenly spaced deadlines up to `earliestArrival + departureWindowSeconds`.
   * 1 is the shipped default and costs one extra RAPTOR pass. Raise it only if
   * real queries are shown to lose MIDDLE departures -- each increment is
   * another full reverse search on every request.
   */
  reverseProbes: intEnv("PLAN_REVERSE_PROBES", 1, 1, 3),
} as const;

/**
 * The other lines offered for each ride of a `/plan` itinerary -- see
 * `transit/alternatives.ts`. `maxPerLeg=0` turns the feature off.
 */
export const alternativesConfig = {
  /**
   * How long after the planned ride a later bus still counts as a fallback for
   * it. Only later, never earlier: the list is for a rider who is late or whose
   * bus never came.
   */
  laterDepartureSeconds: intEnv("PLAN_ALTERNATIVES_LATER_SECONDS", 1_800, 0, 7_200),
  // Half an hour of runs BEFORE the planned ride, for a rider who set out
  // early and caught the one before it (see `AlternativesOptions`).
  earlierDepartureSeconds: intEnv("PLAN_ALTERNATIVES_EARLIER_SECONDS", 1_800, 0, 7_200),
  maxPerLeg: intEnv("PLAN_ALTERNATIVES_MAX_PER_LEG", 8, 0, 20),
} as const;

export const walkConfig = {
  maxMeters: intEnv("WALK_MAX_METERS", 1_000, 1, 10_000),
  speedMps: Number(process.env.WALK_SPEED_MPS ?? "1.33"),
  transferMinSeconds: intEnv("TRANSFER_MIN_SECONDS", 60, 0, 3_600),
  sameStationSeconds: intEnv("SAME_STATION_TRANSFER_SECONDS", 180, 0, 3_600),
  /** Fraction of a pattern's headway required as boarding buffer, on top of
   *  `transferMinSeconds` (`headway.ts`'s `requiredTransferSeconds`). `0`
   *  restores today's flat `transferMinSeconds` exactly -- see that
   *  function's own doc comment for why this is a genuine, tested off
   *  switch and not just a small number. */
  headwayFactor: Number(process.env.TRANSFER_HEADWAY_FACTOR ?? "0.25"),
  transferMaxSeconds: intEnv("TRANSFER_MAX_SECONDS", 600, 0, 3_600),
} as const;

if (!Number.isFinite(walkConfig.speedMps) || walkConfig.speedMps <= 0) {
  throw new Error(`Invalid WALK_SPEED_MPS: ${process.env.WALK_SPEED_MPS}`);
}

/**
 * A negative factor would make `requiredTransferSeconds` return below
 * `baseSeconds`, i.e. make boarding EASIER than today's flat rule -- the
 * global constraint this feature must never violate. Refused at boot, the
 * same way `speedMps` above is: a bad config value should fail loudly once,
 * not silently produce a smaller-than-intended buffer on every request.
 */
if (!Number.isFinite(walkConfig.headwayFactor) || walkConfig.headwayFactor < 0) {
  throw new Error(`Invalid TRANSFER_HEADWAY_FACTOR: ${process.env.TRANSFER_HEADWAY_FACTOR}`);
}

/**
 * A ceiling below the floor is the other way to make boarding easier than
 * today's flat rule, and it is not hypothetical: `requiredTransferSeconds`
 * applies the cap LAST, so `capSeconds < baseSeconds` makes it return the
 * cap -- a buffer SMALLER than `transferMinSeconds`. `raptor.ts` floors the
 * resulting margin at zero and would survive it, but a configuration that
 * can only ever produce nonsense should fail loudly once rather than be
 * silently absorbed by a guard: the operator who set it meant something, and
 * whatever they meant, this is not it.
 */
if (walkConfig.transferMaxSeconds < walkConfig.transferMinSeconds) {
  throw new Error(
    `Invalid TRANSFER_MAX_SECONDS: ${walkConfig.transferMaxSeconds} is below ` +
    `TRANSFER_MIN_SECONDS: ${walkConfig.transferMinSeconds}`,
  );
}

/**
 * Everything the open-bus raw-snapshot poller needs. Present only when
 * `RealtimeConfig.source === "open-bus-vm"` -- the default whenever there is
 * no MOT key (see `resolveRealtimeConfig`).
 */
export interface OpenBusSettings {
  baseUrl: string;
  pollSeconds: number;
  /** Per-visit ghost cutoff on `RecordedAtTime` -- see `openBus.ts`. */
  maxVehicleAgeSeconds: number;
}

/** Which keyless feed to read when there is no MOT key. */
type KeylessSource = "open-bus" | "stride" | "off";

/** Everything the Stride SIRI-VM poller needs. Present only when
 *  `RealtimeConfig.source === "stride-vm"`. */
export interface StrideSettings {
  baseUrl: string;
  pollSeconds: number;
  pageLimit: number;
  maxPages: number;
  /** Per-row ghost cutoff on `recorded_at_time`, deliberately distinct from
   *  `maxAgeSeconds` -- see `stride.ts`'s `parseRow`. */
  maxVehicleAgeSeconds: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface RealtimeConfig {
  enabled: boolean;
  /**
   * Which feed is live, or `null` when realtime is disabled. Stamped onto
   * every prediction and reported on `/meta`.
   */
  source: RealtimeSource | null;
  key: string | null;
  baseUrl: string | null;
  /** Present exactly when `source === "open-bus-vm"`. */
  openBus: OpenBusSettings | null;
  /** Present exactly when `source === "stride-vm"`. */
  stride: StrideSettings | null;
  /** `REALTIME_POLL_SECONDS` -- the `active-calls` stream. */
  pollSeconds: number;
  /** `REALTIME_PLANNED_POLL_SECONDS` -- the `planned` stream. */
  plannedPollSeconds: number;
  maxAgeSeconds: number;
  timeoutMs: number;
}

function emptyToNull(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}

/**
 * Realtime is enabled ONLY when BOTH `MOT_SIRI_KEY`
 * and `MOT_SIRI_BASE_URL` are set and non-empty -- there is no key yet,
 * so `enabled: false` is the expected,
 * long-lived state, and every realtime consumer must treat it as the
 * DEFAULT rather than the exception. One set without the other is a
 * MISCONFIGURATION, not a half-enabled state: this warns, naming the
 * missing variable, and stays disabled -- it deliberately never throws,
 * because a boot failure over an optional enhancement is the wrong trade.
 *
 * Exported as a pure function, separately from the `realtimeConfig` const
 * below that calls it with the real `process.env` / `console.warn`, so a
 * test can exercise every combination of "key present/absent" x "base URL
 * present/absent", and every numeric setting's own bounds, without needing
 * to re-import this module under a different `process.env` -- `config.ts`,
 * like every module here, is a singleton read once at process start, and
 * the whole test suite shares one process.
 */
export function resolveRealtimeConfig(
  env: NodeJS.ProcessEnv, warn: (message: string) => void,
): RealtimeConfig {
  const key = emptyToNull(env.MOT_SIRI_KEY);
  const baseUrl = emptyToNull(env.MOT_SIRI_BASE_URL);

  if (key !== null && baseUrl === null) {
    warn("MOT_SIRI_KEY is set but MOT_SIRI_BASE_URL is not -- realtime stays disabled.");
  } else if (key === null && baseUrl !== null) {
    warn("MOT_SIRI_BASE_URL is set but MOT_SIRI_KEY is not -- realtime stays disabled.");
  }

  const motConfigured = key !== null && baseUrl !== null;
  // Exactly one of the two set. Distinguished from "neither set" because a
  // half-configured MOT pair must NOT fall through to a keyless feed: that
  // would mask a typo'd key as a perfectly working system, which is precisely
  // the failure the existing warn-and-disable behaviour exists to prevent.
  const motHalfSet = (key === null) !== (baseUrl === null);
  const keylessAllowed = !motConfigured && !motHalfSet;

  // Validated whether or not a MOT key makes it moot: a typo here is a
  // configuration that means nothing, and it should say so at boot rather
  // than the day the key is rotated out.
  const keylessRaw = emptyToNull(env.REALTIME_KEYLESS_SOURCE);
  let keyless: KeylessSource;
  if (keylessRaw === null) {
    // `STRIDE_ENABLED=false` predates the open-bus feed and meant "no keyless
    // realtime at all" when Stride was the only one. A deployment that set it
    // must not light up a different feed without being asked.
    keyless = emptyToNull(env.STRIDE_ENABLED) === "false" ? "off" : "open-bus";
  } else if (keylessRaw === "open-bus" || keylessRaw === "stride" || keylessRaw === "off") {
    keyless = keylessRaw;
  } else {
    throw new Error(
      `Invalid REALTIME_KEYLESS_SOURCE: ${keylessRaw} (expected open-bus, stride or off)`,
    );
  }

  // The default keyless feed since 2026-09-13. The same MOT data Stride
  // carries, read from the Public Knowledge Workshop's raw per-minute file
  // instead of from Stride's database, whose ETL lags 13-23 min on a
  // weekday. See `realtime/openBus.ts` for the measurements.
  const openBus: OpenBusSettings | null = keylessAllowed && keyless === "open-bus" ? {
    baseUrl: emptyToNull(env.OPEN_BUS_BASE_URL) ?? "https://open-bus-siri-requester.hasadna.org.il",
    // A minute's file lands ~30 s past the minute. 20 s picks it up within 20 s
    // of that; the floor keeps a typo from hammering a volunteer-run server
    // for an 84-byte status that changes once a minute.
    pollSeconds: intEnv("OPEN_BUS_POLL_SECONDS", 20, 10, 3_600, env),
    // Thirty minutes, the same as Stride's. Most reports here are about half a
    // minute old, but not all: on 2026-09-13 18:47Z every Egged vehicle (688)
    // reported ~21 min late while other operators sat at 74-92 s, and at a
    // weekday peak 9-15% of all reports are over ten minutes old. Ten minutes
    // dropped the country's largest operator outright. Keeping an old report
    // is safe because the store does not ANCHOR one (see
    // ANCHOR_MAX_REPORT_AGE_SECONDS in realtime/store.ts): it gets Stride's
    // plain estimate, not a floor that could pin a gone bus to the board.
    maxVehicleAgeSeconds: intEnv("OPEN_BUS_MAX_VEHICLE_AGE_SECONDS", 1_800, 30, 7_200, env),
  } : null;

  const strideAllowed = keylessAllowed && keyless === "stride";

  const stride: StrideSettings | null = strideAllowed ? {
    baseUrl: emptyToNull(env.STRIDE_BASE_URL) ?? "https://open-bus-stride-api.hasadna.org.il",
    // Stride publishes one snapshot a minute; polling faster only re-reads
    // the same rows and spends someone else's volunteer-run database.
    pollSeconds: intEnv("STRIDE_POLL_SECONDS", 60, 15, 3_600, env),
    // Their hard cap. Asking for more returns an error body, not a bigger
    // page -- the API says so in as many words ("due to abuse").
    pageLimit: intEnv("STRIDE_PAGE_LIMIT", 15_000, 1, 15_000, env),
    // 3 x 15,000 = 45,000, about 4.5x the observed national peak of 10,020.
    maxPages: intEnv("STRIDE_MAX_PAGES", 3, 1, 20, env),
    // 30 minutes, and NOT a conservative guess -- measured. Stride's own
    // ETL lag scales with load: 0.5 min at 01:00 UTC with 124 vehicles
    // moving, but 14-19 min through the whole 04:00-11:00 UTC service peak
    // (max observed 23.7 min over 399 consecutive snapshots on 2026-09-01).
    // A 10-minute cutoff discards the ENTIRE feed during service hours --
    // measured directly: 14,993 of 15,000 rows dropped at 11:25 UTC. This
    // must stay comfortably above that peak lag plus a vehicle's own
    // reporting interval, or the fallback silently does nothing all day.
    maxVehicleAgeSeconds: intEnv("STRIDE_MAX_VEHICLE_AGE_SECONDS", 1_800, 30, 7_200, env),
    // Nationwide by default: complete coverage is the right default, and
    // these exist so the footprint can be shrunk without a code change if
    // their database struggles or we are asked to.
    minLat: floatEnv("STRIDE_MIN_LAT", 29.4, -90, 90, env),
    maxLat: floatEnv("STRIDE_MAX_LAT", 33.4, -90, 90, env),
    minLon: floatEnv("STRIDE_MIN_LON", 34.2, -180, 180, env),
    maxLon: floatEnv("STRIDE_MAX_LON", 35.9, -180, 180, env),
  } : null;

  // An empty or inverted bbox can only ever return nothing. A configuration
  // that cannot produce a working system should fail loudly once, rather
  // than run forever looking like a feed outage -- the same reasoning as the
  // TRANSFER_MAX_SECONDS check above.
  if (stride !== null && (stride.minLat >= stride.maxLat || stride.minLon >= stride.maxLon)) {
    throw new Error(
      `Invalid STRIDE bbox: [${stride.minLat},${stride.minLon}]..` +
      `[${stride.maxLat},${stride.maxLon}] is empty or inverted`,
    );
  }

  return {
    enabled: motConfigured || openBus !== null || stride !== null,
    source: motConfigured ? "siri-sm"
      : openBus !== null ? "open-bus-vm"
      : stride !== null ? "stride-vm"
      : null,
    openBus,
    stride,
    key,
    baseUrl,
    // Floor of 15 per ICD §7.18.2, enforced HERE --
    // not only as `poller.ts`'s defensive `Math.max` clamp, which exists as
    // the last line of defence for a non-finite value, not as the primary
    // check. A typo'd `REALTIME_POLL_SECONDS=5` fails loudly at boot, the
    // same way every other malformed numeric setting in this file does,
    // rather than being silently rounded up to 15 with no operator signal.
    pollSeconds: intEnv("REALTIME_POLL_SECONDS", 30, 15, 3_600, env),
    plannedPollSeconds: intEnv("REALTIME_PLANNED_POLL_SECONDS", 60, 15, 3_600, env),
    maxAgeSeconds: intEnv("REALTIME_MAX_AGE_SECONDS", 180, 1, 3_600, env),
    timeoutMs: intEnv("REALTIME_TIMEOUT_MS", 20_000, 1, 600_000, env),
  };
}

export const realtimeConfig = resolveRealtimeConfig(process.env, (message) => console.warn(message));
