import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveLiveTarget } from "../db/connect.js";
import { buildAppBundle, type AppBundle } from "../db/bundle.js";
import { instantDrain, type Drain } from "../requestDrain.js";
import {
  buildFootpaths, stopSetHash, loadFootpathCache, saveFootpathCache,
  type FootpathOptions,
} from "./footpaths.js";
import { attachFootpaths, type TimetableIndex } from "./index.js";
import type { ValhallaClient } from "../walking/valhalla.js";

export type IndexState = "empty" | "building" | "ready";
export type FootpathMode = "valhalla" | "straight-line" | "none";

/**
 * The live `gtfs.sqlite` symlink is not there right now.
 *
 * This is a TRANSIENT, EXPECTED state, not a fault: `gtfs` publishes
 * a new feed version by unlinking the symlink and recreating it, so any
 * reload landing inside that window finds nothing. `maybeReload()` treats it
 * that way (it catches and returns false); `rebuild()` must agree rather than
 * letting `resolveLiveTarget`'s raw error escape instead — SYNCHRONOUSLY,
 * before the returned promise even exists — which would surface through
 * `POST /admin/reload` as a 500 whose message was the ABSOLUTE SERVER PATH
 * of the symlink. This type is what lets the two agree: `rebuild()` rejects
 * with it, and the route maps it to a 503 the caller can simply retry, with
 * no path in the body.
 */
export class LiveDatabaseUnavailableError extends Error {
  constructor() {
    super("The live database is not currently available; retry shortly.");
    this.name = "LiveDatabaseUnavailableError";
  }
}

/**
 * A client that always reports Valhalla absent, and would throw if
 * `buildFootpaths` ever actually tried to call `matrix` on it (it must
 * not — `ping()` returning `false` makes `buildFootpaths` skip straight to
 * the straight-line estimate for every pair without ever touching
 * `matrix`). Used only as the last-resort fallback in `attachFootpathsTo`
 * when the configured real client/cache path threw outright, to recompute
 * pure straight-line footpaths deterministically. See that method's comment
 * for why this recomputation itself cannot realistically fail.
 */
const ALWAYS_DOWN_CLIENT: Pick<ValhallaClient, "ping" | "matrix"> = {
  ping: async () => false,
  matrix: async () => { throw new Error("ALWAYS_DOWN_CLIENT.matrix must never be called"); },
};

export interface FootpathDeps {
  client: Pick<ValhallaClient, "ping" | "matrix">;
  options: FootpathOptions;
  cacheDir: string;
}

/**
 * Builds the `new Worker(...)` call for the index build. Two runtimes have to
 * work here, and they need different treatment:
 *
 * - Compiled output (`dist/`): `buildWorker.js` exists on disk as plain JS.
 *   `new Worker(path)` just runs it directly, no tsx involved at all.
 *
 * - Dev (`tsx watch src/index.ts`): only `buildWorker.ts` exists. tsx makes
 *   `.ts` sources runnable from the *main* thread by registering Node's ESM
 *   customization hooks via `--import tsx`, but those hooks are thread-local
 *   — `new Worker()` spawns a fresh realm that does not inherit them. A
 *   worker pointed at `buildWorker.js` fails immediately with "Cannot find
 *   module" (nothing by that name exists); pointing it at `buildWorker.ts`
 *   directly gets further (Node/tsx can load a literal `.ts` path with no
 *   resolution guessing needed) but then dies on `buildWorker.ts`'s own
 *   `./index.js` import, because by the time that import is linked, no hook
 *   is registered *in this new thread* to redirect it to `index.ts`. This
 *   was verified empirically, including that passing
 *   `execArgv: ["--import", "tsx"]` does not help: `--import` only sets up
 *   tsx's hooks in time for a worker's *own* entry-file resolution, not for
 *   modules that entry file goes on to import — the port/MessageChannel
 *   handshake tsx's hook registration relies on isn't established until
 *   after the entry module has already started linking.
 *
 *   The fix that does work: register tsx's hooks *programmatically*, from
 *   inside the worker, via `tsx/esm/api`'s `register()` (the same function
 *   `--import tsx` calls under the hood, minus the CLI-only bootstrapping),
 *   and only *then* import the real worker file — as a *dynamic* import, so
 *   it starts a fresh module job after the hooks are live, rather than being
 *   hoisted and linked alongside them. A one-line `eval: true` worker does
 *   exactly that and nothing else; the real logic still lives entirely in
 *   `buildWorker.ts`. `tsx/esm/api` is a devDependency, so this branch must
 *   never run against compiled output — it is gated on `import.meta.url`
 *   ending in `.ts`, which is only true when *this* module itself is being
 *   served by tsx (tsx resolves the `./manager.js` specifier that imported
 *   this file back to `manager.ts` on disk; compiled output naturally ends
 *   in `.js`). Do not "simplify" this away — it is the whole fix.
 */
function spawnBuildWorker(dbPath: string): Worker {
  const dev = import.meta.url.endsWith(".ts");
  if (!dev) {
    return new Worker(
      fileURLToPath(new URL("./buildWorker.js", import.meta.url)),
      { workerData: { dbPath } },
    );
  }
  const target = new URL("./buildWorker.ts", import.meta.url).href;
  const bootstrap = [
    'import { register } from "tsx/esm/api";',
    "register();",
    `await import(${JSON.stringify(target)});`,
  ].join(" ");
  return new Worker(bootstrap, { eval: true, workerData: { dbPath } });
}

function defaultBuild(dbPath: string): Promise<TimetableIndex> {
  return new Promise((resolve, reject) => {
    const worker = spawnBuildWorker(dbPath);
    worker.once("message", (index: TimetableIndex) => {
      // stopIdToIdx survives structured clone as a Map, but rebuilding it is
      // cheap insurance against a clone that drops it.
      if (!(index.stopIdToIdx instanceof Map)) {
        index.stopIdToIdx = new Map(index.stopIds.map((id, i) => [id, i] as const));
      }
      resolve(index);
      void worker.terminate();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`index worker exited with code ${code}`));
    });
  });
}

export class IndexManager {
  private index: TimetableIndex | null = null;
  private bundle: AppBundle;
  private building: Promise<void> | null = null;
  private loadedTarget: string;
  private timer: NodeJS.Timeout | null = null;
  private footMode: FootpathMode = "none";
  private readonly buildFn: (dbPath: string) => Promise<TimetableIndex>;
  private readonly dbBuildFn: (dbPath: string, target: string) => AppBundle;
  private readonly drain: Drain;
  private readonly footpathDeps: FootpathDeps | null;
  private onIndexSwap: ((index: TimetableIndex) => void) | null;

  constructor(
    private readonly dataDir: string,
    opts: {
      buildFn?: (dbPath: string) => Promise<TimetableIndex>;
      dbBuildFn?: (dbPath: string, target: string) => AppBundle;
      drain?: Drain;
      /**
       * When provided, every successful `rebuild()` — not just the first —
       * (re)attaches footpaths to the freshly built index before it can ever
       * be served. Omitting this is an explicit opt-out: nothing manages
       * footpaths automatically, and `footpathMode()` stays whatever it was
       * (only useful for a caller, such as a test, that attaches its own
       * footpaths inside a custom `buildFn` and does not want this manager
       * touching them). Production (`src/index.ts`) always supplies this.
       */
      footpaths?: FootpathDeps;
      /**
       * Notified SYNCHRONOUSLY, immediately after `this.index` is
       * reassigned, on EVERY successful `rebuild()` -- not just when the
       * feed version itself changes (see `attachFootpathsTo`'s own
       * comment: even `POST /admin/reload`'s "force it now" on an
       * UNCHANGED target still produces a brand-new `TimetableIndex`
       * object via `buildFn`, with a fresh internal trip/stop numbering).
       *
       * Exists for state keyed by trip/stop INDICES into one specific
       * `TimetableIndex` -- the realtime resolver's cache, and any
       * predictions already resolved against it -- which must be
       * invalidated before ANY request can observe a mismatch, rather than
       * lazily on whatever next happens to touch it. Because this runs
       * synchronously, in the same turn of the event loop as the swap
       * itself (no `await` between the `this.index = nextIndex` assignment
       * below and this call), there is no window in which a request can
       * read the NEW index while a caller-owned cache still answers
       * questions about the OLD one.
       */
      onIndexSwap?: (index: TimetableIndex) => void;
    } = {},
  ) {
    this.buildFn = opts.buildFn ?? defaultBuild;
    this.dbBuildFn = opts.dbBuildFn ?? buildAppBundle;
    this.drain = opts.drain ?? instantDrain;
    this.footpathDeps = opts.footpaths ?? null;
    this.onIndexSwap = opts.onIndexSwap ?? null;

    // Built synchronously, right here, unlike the RAPTOR index below: browse
    // endpoints and /meta's top-level fields must be servable the instant
    // this manager exists, not only once the (asynchronous, worker-thread)
    // index has finished its first build. This mirrors exactly what this
    // constructor replaces — a bare `openTransitDb(paths.dataDir)` call at
    // the very top of index.ts, before the server even started listening.
    // A missing symlink throws here for the identical reason it threw there.
    const target = resolveLiveTarget(dataDir);
    this.bundle = this.dbBuildFn(join(dataDir, target), target);
    this.loadedTarget = target;
  }

  current(): TimetableIndex | null { return this.index; }
  /**
   * The database, translator, calendar and route lookups currently being
   * served. Never null — see the constructor. Callers should re-invoke this
   * on every access rather than caching the result: it changes identity on
   * every successful feed swap (see `rebuild()`).
   */
  currentBundle(): AppBundle { return this.bundle; }
  state(): IndexState {
    if (this.building !== null) return "building";
    return this.index === null ? "empty" : "ready";
  }
  footpathMode(): FootpathMode { return this.footMode; }
  setFootpathMode(mode: FootpathMode): void { this.footMode = mode; }

  /**
   * Registers (or clears, with `null`) the `onIndexSwap` hook AFTER
   * construction -- needed because `realtime/wiring.ts`'s
   * `createRealtimeRuntime` takes an already-constructed `IndexManager` (so
   * its resolver can read `.current()`/`.currentBundle()`), but the hook it
   * returns must still reach THIS manager before any `rebuild()` runs.
   * Passing it through the constructor option (still supported, for a
   * caller that already has the callback in hand at construction time)
   * would require the callback to exist before the manager itself does --
   * exactly backwards for realtime's own construction order. Safe to call
   * any time before the next `rebuild()` completes; calling it while a
   * rebuild is already in flight only affects THAT rebuild if it has not
   * yet reached the swap (this is plain synchronous assignment, nothing
   * about the in-flight build reads it early).
   */
  setOnIndexSwap(cb: ((index: TimetableIndex) => void) | null): void { this.onIndexSwap = cb; }

  /**
   * Attaches footpaths to a freshly built (not-yet-served) index and reports
   * which mode it ended up in. Called from `rebuild()` BEFORE the new index
   * is swapped in, so no request can ever observe an index with the empty
   * `footOffset`/`footTarget`/`footSeconds` arrays `buildIndex` always
   * starts a fresh `TimetableIndex` with.
   *
   * Cache-first, exactly like the original bootstrap-only code this
   * replaces: `stopSetHash` is keyed on the stop set (plus the walk options
   * baked into the arrays), not the feed version, so a normal nightly swap
   * (stops rarely change, options do not change at all) hits the cache and
   * attaches in milliseconds rather than re-querying Valhalla for several
   * hundred thousand pairs — while a retuned `WALK_MAX_METERS` and friends
   * correctly miss it and rebuild.
   *
   * DEGRADED-VS-STALE DECISION: if the cache-and-Valhalla path throws
   * outright (not merely "Valhalla unreachable", which `buildFootpaths`
   * already degrades to a `"straight-line"` MODE rather than an exception —
   * this catch is for something actually broken: a corrupt cache file that
   * fails to parse, or a future change violating an invariant), this falls
   * back to recomputing footpaths against `ALWAYS_DOWN_CLIENT`, i.e. a
   * fresh index with straight-line footpaths, rather than leaving the
   * caller to fall back to the OLD index. Reasoning: the RAPTOR index
   * carries the actual schedule, and the live feed's calendar window is
   * only ~30 days wide — a service that refuses to adopt a new index
   * because footpath attachment glitched risks eventually serving a
   * calendar window that no longer covers "today" at all (a guaranteed
   * `422` for every query), which is strictly worse than degraded walking
   * transfers on an otherwise-current schedule. This mirrors the exact
   * philosophy already applied to a plain Valhalla outage (degrade, don't
   * die) rather than inventing a new policy for this path. The fallback
   * recomputation is pure arithmetic over already-validated config
   * (`WALK_MAX_METERS`/`TRANSFER_MIN_SECONDS`/etc. are bounds-checked at
   * process start in config.ts, before any `IndexManager` exists), so it
   * cannot itself throw for a config reason; if it somehow still throws,
   * `rebuild()`'s caller sees that rejection and — correctly — keeps
   * serving the OLD index, since nothing has been swapped yet at that point.
   */
  private async attachFootpathsTo(ix: TimetableIndex, deps: FootpathDeps): Promise<FootpathMode> {
    const hash = stopSetHash(ix, deps.options);
    try {
      const cached = loadFootpathCache(deps.cacheDir, hash);
      if (cached !== null) {
        attachFootpaths(ix, cached.offsets, cached.targets, cached.seconds);
        // A cache hit is always a real Valhalla result -- see the comment
        // below on why only "valhalla" mode is ever cached.
        ix.footpathsRouted = true;
        return "valhalla";
      }
      const { arrays, mode } = await buildFootpaths(ix, deps.client, deps.options);
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      ix.footpathsRouted = mode === "valhalla";
      // Only a real Valhalla result is ever cached -- caching a degraded
      // straight-line run would make a one-off outage permanent, since the
      // next reload would load the stale straight-line cache and never even
      // try Valhalla again.
      if (mode === "valhalla") saveFootpathCache(deps.cacheDir, hash, arrays);
      return mode;
    } catch {
      const { arrays } = await buildFootpaths(ix, ALWAYS_DOWN_CLIENT, deps.options);
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      ix.footpathsRouted = false;
      return "straight-line";
    }
  }

  /**
   * Single-flight, matching gtfs's ImportRunner: overlapping callers
   * share one build rather than starting a second 200 MB one. The previous
   * index (and the previous db bundle) keep serving throughout — nothing is
   * replaced until the new build succeeds, so a request landing mid-rebuild
   * never sees null, a half-built index, or a mix of old and new db state.
   *
   * The RAPTOR index and the db-derived bundle are built from ONE resolved
   * path and swapped as ONE atomic pair: if `buildFn` throws, execution never
   * reaches the bundle build or either assignment below, so the two can never
   * end up disagreeing about which feed version they serve. Footpaths are
   * attached to the new index (see `attachFootpathsTo`) BEFORE that same
   * swap too, so `footpathMode()` always describes the index actually being
   * served, never a stale value left over from an earlier build.
   */
  rebuild(): Promise<void> {
    if (this.building !== null) return this.building;

    // A missing symlink is transient (see LiveDatabaseUnavailableError), and
    // must leave this method the same way every other failure does: as a
    // REJECTED PROMISE, never as a synchronous throw. `void manager.rebuild()
    // .catch(...)` — how the reload route and the poller both call it — does
    // not catch a synchronous throw at all, so the old behaviour turned a
    // routine publish window into an unhandled 500 carrying a server path.
    const target = this.liveTarget();
    if (target === null) return Promise.reject(new LiveDatabaseUnavailableError());
    const dbPath = join(this.dataDir, target);
    const run = (async () => {
      try {
        const nextIndex = await this.buildFn(dbPath);

        // Every freshly built TimetableIndex starts with empty footpath
        // arrays (buildIndex always sets footTarget/footSeconds to length
        // 0) -- this must run on EVERY successful rebuild, not just the
        // first, or a feed swap silently strips the service of all walking
        // transfers until the next process restart.
        const nextFootMode = this.footpathDeps !== null
          ? await this.attachFootpathsTo(nextIndex, this.footpathDeps)
          : this.footMode;

        // Reopen the db bundle only when the live target actually changed.
        // `rebuild()` always rebuilds the RAPTOR index even when asked to
        // redo an unchanged target (POST /admin/reload's whole point is
        // "force it now"), but the bundle reflects a FEED VERSION, not
        // "was rebuild called" — an unchanged target is already the right
        // bundle, and reopening it would reparse the ~10 MB translations
        // table and re-run the route-lookup query for no observable
        // difference.
        const nextBundle = target === this.loadedTarget
          ? this.bundle
          : this.dbBuildFn(dbPath, target);

        const oldBundle = this.bundle;
        this.index = nextIndex;
        this.bundle = nextBundle;
        this.footMode = nextFootMode;
        this.loadedTarget = target;

        this.onIndexSwap?.(nextIndex);

        if (oldBundle !== nextBundle) {
          // Close the handle the PREVIOUS bundle held only once no request
          // that read `currentBundle()` before this swap can still be
          // reading through it — never synchronously with the swap itself.
          // See requestDrain.ts's own comment: this can only wait too long,
          // never close too soon.
          void this.drain.whenDrained().then(() => oldBundle.db.close());
        }
      } finally {
        this.building = null;
      }
    })();

    this.building = run;
    return run;
  }

  /**
   * The live symlink's current target, or `null` when it is (transiently)
   * absent — briefly, during one of the fetcher's swaps, or permanently
   * before the very first import. Neither is worth taking the service down
   * for, which is why this reports absence as a value rather than throwing.
   * The single place `resolveLiveTarget`'s path-carrying error is swallowed.
   */
  liveTarget(): string | null {
    try {
      return resolveLiveTarget(this.dataDir);
    } catch {
      return null;
    }
  }

  /** Rebuilds only if the fetcher has repointed the symlink. */
  async maybeReload(): Promise<boolean> {
    const target = this.liveTarget();
    if (target === null) return false;
    if (target === this.loadedTarget) return false;
    await this.rebuild();
    return true;
  }

  startPolling(ms: number): void {
    this.stop();
    this.timer = setInterval(() => { void this.maybeReload().catch(() => {}); }, ms);
    // Never hold the process open for a poll.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }
}
