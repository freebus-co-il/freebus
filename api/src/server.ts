import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest,
} from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { config, geocoderConfig, isProduction, valhallaConfig, walkConfig } from "./config.js";
import { ValhallaClient, straightLineWalk } from "./walking/valhalla.js";
import { buildGeocoder } from "./geocode/buildGeocoder.js";
import type { Geocoder } from "./geocode/types.js";
import { healthRoutes } from "./routes/health.js";
import { stopRoutes } from "./routes/stops.js";
import { geocodeRoutes } from "./routes/geocode.js";
import { modeRoutes } from "./routes/modes.js";
import { agencyRoutes } from "./routes/agencies.js";
import { lineRoutes } from "./routes/lines.js";
import { tripRoutes } from "./routes/trips.js";
import { departureRoutes } from "./routes/departures.js";
import { metaRoutes } from "./routes/meta.js";
import { adminRoutes } from "./routes/admin.js";
import { planRoutes } from "./routes/plan.js";
import { segmentRoutes } from "./routes/segments.js";
import { journeyCheckRoutes } from "./routes/journeyCheck.js";
import { planOnboardRoutes } from "./routes/planOnboard.js";
import { walkRoutes } from "./routes/walk.js";
import { vehicleRoutes } from "./routes/vehicles.js";
import type { DbHandle } from "./db/connect.js";
import type { RouteBriefByIdx } from "./db/bundle.js";
import { Translator } from "./db/i18n.js";
import type { CalendarRow } from "./transit/calendar.js";
import type { IndexManager } from "./transit/manager.js";
import type { RequestDrain } from "./requestDrain.js";
import {
  ApiError, codeForFrameworkError, codeForStatus, type ErrorBody,
} from "./errors.js";
import type { RealtimeStore } from "./realtime/store.js";
import type { SiriPoller, StreamFilter, StreamStatus } from "./realtime/poller.js";

export interface ServerDeps {
  index: IndexManager;
  /**
   * Wired to `onRequest`/`onResponse` hooks below when provided, so
   * `IndexManager` can tell when it is safe to close a database handle a
   * feed swap just superseded. Optional because most tests build a server
   * with no real HTTP traffic to protect — see `requestDrain.ts`'s
   * `instantDrain`, which `IndexManager` falls back to on its own.
   */
  drain?: RequestDrain;
  /**
   * Shared secret `POST /admin/reload` requires. Defaults to
   * `config.adminToken`, i.e. `TRANSIT_ADMIN_TOKEN`, which is `null` when
   * that variable is unset — and `null` means the route refuses EVERY
   * request (see `routes/admin.ts`). Passed as a dependency rather than read
   * from `config` inside the route so a test can exercise both the
   * authorised and the unauthorised path in one process, without the
   * module-load-time env capture `config.ts` deliberately does.
   */
  adminToken?: string | null;
  /** Overrides the request-time walking router; tests inject a stub so the
   *  suite never needs a Valhalla container. */
  valhalla?: Pick<ValhallaClient, "route" | "matrix">;
  /** Overrides the request-time geocoder; tests inject a stub so the suite
   *  never needs a Photon container or a Google key. */
  geocoder?: Geocoder;
  /**
   * The realtime store, present only when `MOT_SIRI_KEY` and
   * `MOT_SIRI_BASE_URL` are both configured; omitted (or `null`) otherwise.
   * Decorated onto `app.realtime` AS-IS -- `null` is the NORMAL state (we
   * have no key yet), and every consumer (this route file's future
   * siblings, `/meta` below) must treat it as the default, not the
   * exception.
   *
   * The `SiriPoller` that keeps this store current is built by
   * `realtime/wiring.ts`'s `createRealtimeRuntime` and STARTED in
   * `index.ts`, never here: `buildServer` is called constantly by tests,
   * and must never itself arm a background timer. The store itself does no
   * I/O and holds no timer, so accepting one here as a plain dependency is
   * safe -- see `store.ts`.
   */
  realtime?: RealtimeStore | null;
  /**
   * Narrowed to `consecutiveFailures`/`streamStatuses` only -- never the
   * full `SiriPoller`, which also exposes `start`/`stop` -- so `/meta` can
   * fold the poller's own tick outcomes (combined, via `consecutiveFailures`
   * for the reported "failing" state; per-stream, via `streamStatuses`)
   * into its reported health without any route handler
   * being able to reach the poller's lifecycle controls.
   */
  realtimePoller?: {
    consecutiveFailures: number;
    /**
     * OPTIONAL because it is a SIRI-SM concept: that poller runs two named
     * streams, while the Stride SIRI-VM poller runs a single unnamed one and
     * carries no such record. The getter below already falls back to a
     * never-polled placeholder, so a poller without this reports its health
     * through `consecutiveFailures` alone rather than through invented
     * stream names.
     */
    streamStatuses?: Record<StreamFilter, StreamStatus>;
  } | null;
}

/**
 * `pino-pretty` runs as a worker thread that neither Fastify's close() nor
 * pino terminates; it is reclaimed only on garbage collection. Under
 * `node --test`'s parallel file runner those threads accumulate and can hang
 * the whole suite — a failure gtfs hit and documented. NODE_TEST_CONTEXT
 * is set by node's test runner in every child process it spawns, so this opts
 * out precisely there while `npm run dev` keeps pretty output.
 */
const usePrettyTransport = !isProduction && !process.env.NODE_TEST_CONTEXT;

/**
 * The fixed message every 5xx gets. The real error is in the log, under the
 * request id echoed back in the body.
 */
const FAULT_MESSAGE =
  "The service failed to handle this request. Quote requestId when reporting it.";

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(usePrettyTransport ? { transport: { target: "pino-pretty" } } : {}),
    },
    trustProxy: isProduction,
    // PRE-ROUTER errors. Fastify raises a few failures before routing
    // happens at all -- a URL component that is not valid percent-encoding
    // (`/trips/%ZZ`, 400) and a path parameter past `maxParamLength`
    // (`/trips/<101 chars>`, 414) -- and `setErrorHandler` never sees them,
    // because there is no route yet to handle them for. Without this hook
    // Fastify answers them itself, with the old three-key body AND the
    // internal identifier as the public code:
    //
    //   {"error":"Bad Request","code":"FST_ERR_MAX_PARAM_LENGTH",...}
    //
    // Nothing sensitive leaks there, but it made two of this service's own
    // contract claims false: that every error uses one envelope, and that
    // `FST_ERR_*` identifiers never reach a client. Same envelope, same
    // requestId treatment, same 4xx-passes-its-message / 5xx-is-genericised
    // rule as `setErrorHandler` below -- and the real status is PRESERVED,
    // so a 414 stays a 414 rather than being flattened into 400.
    // Params annotated explicitly: Fastify types `frameworkErrors` as a
    // generic function whose reply-code/body parameters resolve to `never`
    // under their own defaults, so inference here rejects any `send()` at all.
    frameworkErrors: (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      const requestId = req.id;
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;

      if (status >= 400 && status < 500) {
        req.log.info({ err, statusCode: status }, "client error (pre-router)");
        const body: ErrorBody = {
          statusCode: status,
          code: codeForFrameworkError(err.code, status),
          message: err.message,
          requestId,
        };
        return reply.code(status).send(body);
      }

      req.log.error({ err, statusCode: status }, "request failed (pre-router)");
      const body: ErrorBody = {
        statusCode: 500,
        code: codeForStatus(500),
        message: FAULT_MESSAGE,
        requestId,
      };
      return reply.code(500).send(body);
    },
  });

  // `db`, `translator`, `calendar` and the route lookups all come from the
  // SAME `IndexManager`-owned bundle, decorated as GETTERS rather than
  // one-time values: every existing `app.db.db` / `app.translator` /
  // `app.calendar` / `app.routeBriefByIdx` / `app.routeTypeByIdx` call site
  // keeps working unchanged, but now reads whatever bundle is CURRENT at
  // the moment of the call rather than whatever was current when the server
  // was built. Before this, these five were captured once here and never
  // updated — a feed swap correctly rebuilt the RAPTOR index (via
  // IndexManager) but left every browse endpoint and /meta's top-level
  // fields serving the database open at process start, forever. See
  // IndexManager's own comment for how the swap itself stays atomic and
  // safe. `{ getter }` is Fastify's own documented decoration form
  // (`fastify/lib/decorate.js` installs it via `Object.defineProperty`), not
  // a workaround.
  app.decorate("db", { getter: () => deps.index.currentBundle().db });
  app.decorate("translator", { getter: () => deps.index.currentBundle().translator });
  app.decorate("calendar", { getter: () => deps.index.currentBundle().calendar });
  app.decorate("routeBriefByIdx", { getter: () => deps.index.currentBundle().routeBriefByIdx });
  app.decorate("routeTypeByIdx", { getter: () => deps.index.currentBundle().routeTypeByIdx });
  app.decorate("index", deps.index);
  app.decorate("transitTimezone", config.timezone);
  // Request-time walking routes (walk-leg geometry). Separate from the client
  // IndexManager uses for the footpath matrix: that one runs at build time,
  // this one per request. Both degrade to straight-line rather than throwing.
  //
  // Under `node --test` the default is an INERT client, not a real one. Every
  // existing test builds a server without injecting one, and a real client
  // would then issue live HTTP to whatever is listening on the configured
  // Valhalla port -- measured: 6 real calls per suite run against a container
  // that happened to be up. That breaks the project's hermetic-test rule, and
  // on a machine with nothing listening it turns into a per-call connection
  // timeout instead. NODE_TEST_CONTEXT is what node's runner sets in every
  // child process it spawns, the same signal `usePrettyTransport` above uses.
  // A test wanting real behaviour injects `deps.valhalla` explicitly.
  const inertWalkRouter: Pick<ValhallaClient, "route" | "matrix"> = {
    route: async (from, to) => straightLineWalk(from, to, walkConfig.speedMps),
    // Throws, deliberately, rather than resolving with an all-null row: an
    // all-null row that MATCHES candidates.length is not a failure to
    // accessRefine.ts -- it is genuine "nothing here is walkable"
    // information (see its own doc comment on the `cost === null` branch),
    // so every candidate would be individually filtered OUT, not returned
    // untouched. That would turn every coordinate-based /plan test into a
    // false 422 the moment app.valhalla gained a real `matrix`. A throw
    // takes refinement's actual "degrade, never fail" catch path instead --
    // the same one a genuinely unreachable Valhalla container takes -- so
    // refinement is a no-op and every existing test keeps seeing today's
    // straight-line-estimate behaviour unless it injects its own client.
    matrix: async () => { throw new Error("no Valhalla in tests"); },
  };
  app.decorate("valhalla", deps.valhalla
    ?? (process.env.NODE_TEST_CONTEXT
      ? inertWalkRouter
      : new ValhallaClient({ ...valhallaConfig, speedMps: walkConfig.speedMps })));
  // Same NODE_TEST_CONTEXT convention as `valhalla` above: no test builds a
  // server that talks to a real geocoder unless it explicitly injects
  // `deps.geocoder`.
  const inertGeocoder: Geocoder = {
    search: async () => [],
    place: async () => null,
    reverse: async () => null,
  };
  app.decorate("geocoder", deps.geocoder
    ?? (process.env.NODE_TEST_CONTEXT ? inertGeocoder : buildGeocoder(geocoderConfig, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) })));
  // `null` is the normal state (no MOT_SIRI_KEY/MOT_SIRI_BASE_URL yet) --
  // see ServerDeps.realtime's own comment. No getter here: unlike `db`/
  // `translator`/etc., the STORE's own identity never changes across a feed
  // swap (it's constructed once, in index.ts, for the process lifetime) --
  // only its internal snapshot does, via its own `replace()`.
  app.decorate("realtime", deps.realtime ?? null);
  app.decorate("realtimeConsecutiveFailures", {
    getter: () => deps.realtimePoller?.consecutiveFailures ?? 0,
  });
  app.decorate("realtimeStreamStatuses", {
    getter: (): Record<StreamFilter, StreamStatus> => deps.realtimePoller?.streamStatuses ?? {
      "active-calls": { lastSuccessAt: null, failures: 0, lastError: null },
      planned: { lastSuccessAt: null, failures: 0, lastError: null },
    },
  });

  if (deps.drain !== undefined) {
    const drain = deps.drain;
    // Counts requests in flight so IndexManager knows when it is safe to
    // close a handle a feed swap just superseded. Registered as the very
    // first/last hooks so the window it measures covers the whole request,
    // not just the route handler.
    app.addHook("onRequest", (_req, _reply, done) => { drain.begin(); done(); });
    app.addHook("onResponse", (_req, _reply, done) => { drain.end(); done(); });
  }

  // EVERY non-2xx body in this service is produced here, in one place, in
  // the one shape `errors.ts` documents. Two rules, and the split between
  // them is the whole point:
  //
  //  - A 4xx is INTENTIONAL. Its message was written to be read by the
  //    caller who caused it ("Invalid place: 1,2,3", "querystring must have
  //    required property 'from'"), so it passes through verbatim. Suppressing
  //    it would make every client mistake indistinguishable from every other.
  //
  //  - A 5xx is a FAULT. Its message was written by whatever broke, for us,
  //    and is routinely an internal detail: before this handler existed a
  //    failing query answered `{"code":"SQLITE_ERROR","message":"no such
  //    column: nope"}` (schema and driver disclosure) and a reload during
  //    the fetcher's symlink-unlink window answered with an ABSOLUTE SERVER
  //    PATH. So the fault is logged server-side in full — stack, cause,
  //    driver code, everything — under the request id, and the client gets
  //    a fixed generic message plus that same id. Nothing else crosses the
  //    boundary: no SQLite code, no driver text, no stack, no filesystem path.
  //
  // `ApiError` is the escape hatch for a DELIBERATE non-4xx error body
  // (`/plan`'s 503 `index_not_ready`, `/ready`'s 503): those carry their own
  // vetted code/message and are not faults, so they are not genericised.
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    const requestId = req.id;

    if (err instanceof ApiError) {
      const body: ErrorBody = {
        statusCode: err.statusCode,
        code: err.code,
        message: err.message,
        requestId,
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
      if (err.headers !== undefined) void reply.headers(err.headers);
      return reply.code(err.statusCode).send(body);
    }

    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Logged at `info`, not `error`: a client sending a bad query is not
      // a service fault, but it is still worth being able to see.
      req.log.info({ err, statusCode: status }, "client error");
      const body: ErrorBody = {
        statusCode: status,
        code: codeForStatus(status),
        message: err.message,
        requestId,
      };
      return reply.code(status).send(body);
    }

    req.log.error({ err, statusCode: status }, "request failed");
    const body: ErrorBody = {
      statusCode: 500,
      code: codeForStatus(500),
      message: FAULT_MESSAGE,
      requestId,
    };
    return reply.code(500).send(body);
  });

  // Fastify's default 404 does not pass through setErrorHandler, so it would
  // otherwise be the one remaining body in a different shape.
  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      statusCode: 404,
      code: codeForStatus(404),
      message: `Route ${req.method} ${req.url} not found`,
      requestId: req.id,
    };
    return reply.code(404).send(body);
  });

  await app.register(sensible);
  // Permissive CORS: this is a read-only public data API with no credentials
  // and no user state, so there is nothing for an origin restriction to protect.
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(healthRoutes);
  await app.register(stopRoutes);
  await app.register(geocodeRoutes);
  await app.register(agencyRoutes);
  await app.register(modeRoutes);
  await app.register(lineRoutes);
  await app.register(tripRoutes);
  await app.register(departureRoutes);
  await app.register(metaRoutes);
  await app.register(adminRoutes, {
    adminToken: deps.adminToken === undefined ? config.adminToken : deps.adminToken,
  });
  await app.register(planRoutes);
  await app.register(segmentRoutes);
  await app.register(journeyCheckRoutes);
  await app.register(planOnboardRoutes);
  await app.register(walkRoutes);
  await app.register(vehicleRoutes);

  return app;
}

export type { RouteBriefByIdx } from "./db/bundle.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DbHandle;
    translator: Translator;
    calendar: CalendarRow[];
    index: IndexManager;
    transitTimezone: string;
    /** Route brief by route index, parallel to TimetableIndex.routeIds. */
    routeBriefByIdx: RouteBriefByIdx[];
    /** GTFS route_type by route index, parallel to TimetableIndex.routeIds. */
    routeTypeByIdx: number[];
    /** Request-time walking router, used for walk-leg geometry and access/
     *  egress walk refinement. */
    valhalla: Pick<ValhallaClient, "route" | "matrix">;
    /** Request-time geocoder behind `/geocode/*` -- Photon or Google,
     *  per `GEOCODER`. See ServerDeps.geocoder. */
    geocoder: Geocoder;
    /** `null` when realtime isn't configured -- the normal state. See
     *  ServerDeps.realtime. */
    realtime: RealtimeStore | null;
    /** Highest consecutive-failure count across the poller's two streams,
     *  read fresh on every access; 0 when realtime is disabled or every
     *  recent tick succeeded. See ServerDeps.realtimePoller. */
    realtimeConsecutiveFailures: number;
    /** Per-stream diagnostics, read fresh on every
     *  access; both streams report the all-null/zero shape when realtime
     *  is disabled or no poller was supplied. See ServerDeps.realtimePoller. */
    realtimeStreamStatuses: Record<StreamFilter, StreamStatus>;
  }
}
