# api

Fastify + TypeScript service that reads the SQLite database `gtfs`
publishes and serves the public-transit route-planning app: network
browsing, departure boards, and multi-leg A→B journey planning with walking
transfers.

`gtfs` is the only writer of that database and exposes only its own
operational endpoints (`/health`, `/status`, `/refresh`); it serves no
transit data itself. This service is the reader it was built for: read-only,
against `<repo-root>/data/gtfs.sqlite`, resolving that symlink fresh on
every reload poll so a feed swap by the fetcher is picked up without a
restart (see [How it works](#how-it-works)).

This README describes what actually shipped, including several places
review found the original design plan wrong and the fix diverged from it:
see [Known limitations](#known-limitations) and [Testing](#testing) below.

## Requirements

- Node.js >= 22
- Docker, to run Valhalla (real street-network walking) and Photon (address
  search), both optional. Without Valhalla, walking distances fall back to
  a straight-line estimate; without Photon, address search returns no
  results and stop-name search keeps working on its own.
- Or, instead of Photon, a Google Maps API key with `GEOCODER=google` (see
  [Address search backends](#address-search-backends)).

## Setup

```
npm install
cp .env.example .env
docker compose up -d valhalla photon
npm run dev
```

`docker compose up -d valhalla photon` only needs to be run once per machine: the
containers' **first** start downloads data and builds indexes. Valhalla
downloads an OSM extract and builds routing tiles, which takes roughly 10–20
minutes. Until that finishes (or if you skip Valhalla entirely), the service
starts and serves normally: walking distances fall back to a straight-line
estimate, visible as `"footpaths": "straight-line"` in `GET /meta`. Subsequent
starts reuse the built tiles in `./valhalla-data` and come up in seconds.

Photon's first start downloads a **prebuilt** index instead of building one
itself: `PHOTON_PREBUILT_URL` in the compose file points at the result of
[`build-photon-index.yml`](../.github/workflows/build-photon-index.yml), a
manually-triggered GitHub Actions workflow that runs the real import once
and publishes it as a release asset (`photon-index-latest`). That download
is small (~130 MB compressed) and just gets extracted: seconds, not
minutes.

The real import still exists (`photon/entrypoint.sh`'s other branch) for
when `PHOTON_PREBUILT_URL` is unset. No current-format *prebuilt* Israel
dump is published anywhere else (see the entrypoint's comments for why),
so building it yourself means streaming Photon's own ~2.8 GB Asia jsonl
dump and filtering it down during import, on 2 ARM vCPUs. **Measured**
2026-08-24 under a 2 vCPU / 2 GB cap (Photon's realistic share of the
production box): ~12.5 minutes, ~1 GB peak RSS. That RAM spike competes
directly with api/Valhalla/gtfs on a 4 GB box, which is the whole reason
the prebuilt path above is the default; reserve the real import for
regenerating the published index (re-run the workflow) or local dev
against a from-scratch build.

If `docker compose logs photon` shows "flood stage disk watermark" during
either path, that means the host is low on free disk (OpenSearch checks
the *whole* disk, not just its own usage, and needs roughly 5% of total disk
free), not a code problem.

Subsequent starts of either path reuse the data in `./photon-data` via the
`.import-complete` marker.

## Address search backends

`GEOCODER` picks who answers `/geocode/*`:

- **`photon`** (default): self-hosted Photon over OpenStreetMap. Free, but
  OSM is missing most businesses and many addresses in Israel.
- **`google`**: Google Places API (New) autocomplete + Place Details, and the
  Geocoding API for reverse. Finds what riders actually type. **Metered.**

The API contract is the same for both, which is what makes the switch an env
var and not a client release: a place carries either a position (Photon) or a
`placeId` the client resolves through `/geocode/place` (Google).

How the Google path is kept cheap (the full reasoning is in
[`src/geocode/google.ts`](src/geocode/google.ts)):

| | why |
| --- | --- |
| **Session tokens** | Searches while typing and the one resolve after the pick share a token. A session ending in Place Details Essentials bills at most 12 autocomplete calls; without a token every call bills. |
| **Positions only for the pick** | Autocomplete never returns coordinates, and this does not fetch them per suggestion (up to 5 Place Details per keystroke). One resolve, for the tapped row. |
| **`location` field mask** on Place Details | Keeps it in the Essentials SKU ($5/1k). `displayName` alone would make it Pro ($17/1k). |
| **Client debounce 450 ms, min 3 chars, 5 min cache** | Fewer autocomplete calls per session: the part a rider who picks a *stop* instead leaves billed per call. Stop search keeps its own faster 275 ms debounce. |
| **Daily ceiling** | `GOOGLE_MAPS_DAILY_REQUEST_LIMIT`, since the API is public and CORS-open. |
| **`no-store`** on `/geocode*` in the Caddyfile | A cached answer would carry someone else's session. |

In production, `deploy.sh` also builds and starts the Photon container only
when `GEOCODER=photon`, and removes its container and image when it is
`google`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with `tsx watch` (hot reload, pretty logs) |
| `npm run typecheck` | Type check without emitting |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled build (`node dist/index.js`) |
| `npm test` | Run the hermetic test suite: no network, no container, no 666 MB database |
| `npm run test:live` | Build the real timetable index from the live database (see [Testing](#testing)) |
| `npm run bake:rail` | Rebuild `assets/rail-geometry.json`, the train track lines, from OpenStreetMap (see [Train track lines](docs/how-it-works.md#train-track-lines)) |

`npm run dev` and `npm start` are not just "the same thing, one compiled":
building the RAPTOR index runs in a worker thread (`new Worker(...)`), and
`tsx`'s ESM loader hooks are thread-local; they do not propagate into a
freshly spawned worker realm. `npm start` runs plain compiled JS, where
`new Worker("./buildWorker.js")` just works. Dev mode instead spawns the
worker with a one-line `eval: true` bootstrap that registers
`tsx/esm/api`'s loader **inside** the new thread and only then dynamically
imports the real `buildWorker.ts`. The dev-only branch is gated on
`import.meta.url` ending in `.ts`, so it can never fire against compiled
output. See the comment on `spawnBuildWorker` in
[`src/transit/manager.ts`](src/transit/manager.ts) for the full story,
including why the simpler `execArgv: ["--import", "tsx"]` fix does not work.

## HTTP API

All times in responses are ISO-8601 with offset
(`2026-08-24T08:14:00+03:00`). The one endpoint that also exposes the raw
GTFS seconds-after-midnight representation (which legitimately exceeds 86400
for late-night service and is never clamped) is `GET /trips/:tripId`, which
carries `arrivalSeconds`/`departureSeconds` **alongside**, not instead of,
ISO `arrivalTime`/`departureTime` (see [that endpoint](#browse) below for
which service date the ISO values are rendered against). Everywhere else,
ISO only. `lang` defaults to `he` and accepts `he`/`en`/`ar`
(case-insensitive); an unsupported value is a `400`, not a silent fallback.
List endpoints validate every parameter through a Fastify JSON schema.

### Ops and metadata

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness. Answers immediately, even mid-index-build. |
| `GET /ready` | `200` only once a RAPTOR index has been built at least once; `503` with `Retry-After` before that. Separate from `/health` because the process is alive but cannot answer a data question during the build. |
| `GET /meta` | Feed `version`, `fetchedAt`, table `counts`, the calendar `serviceWindow`, index state (`empty`/`building`/`ready`) and its own `version`, footpath mode (`valhalla`/`straight-line`/`none`), and a `realtime` health block (see [Realtime](#realtime-siri-sm) below). All of it, including the top-level `version`/`fetchedAt`/`counts`, refreshes on a feed swap; see [How it works](#how-it-works). |
| `POST /admin/reload` | Forces a symlink re-check and index rebuild. **Authenticated**: requires `Authorization: Bearer $TRANSIT_ADMIN_TOKEN`; see [Configuration](#configuration). `202 { status: "started" }`; `401` if the token is absent, wrong, or unconfigured; `409` (`rebuild_already_running`) if a rebuild is already in flight; `503` (`live_database_unavailable`) if the live symlink is transiently absent mid-publish. |

### Browse

| Route | Notes |
| --- | --- |
| `GET /agencies` | All 36, as `{ agencyId, name, url, timezone, phone }`. |
| `GET /stops/search?q=&lang=&limit=` | FTS5 over the Hebrew feed text, plus an in-memory scan of the `lang` translation table so an English or Arabic query matches too. `limit` caps at 50 (default 20). |
| `GET /stops/nearby?lat=&lon=&radius=&limit=&lang=` | Grid/R\*Tree-prefiltered, then exact haversine for the true radius and sort order. `radius` default 500 m, cap 2000. `limit` caps at 100 (default 25). |
| `GET /geocode/search?q=&lang=&limit=&session=&lat=&lon=` | Free-text place/address search over the `GEOCODER` backend (see [Address search backends](#address-search-backends)). Each place is `{ label, secondaryLabel, lat, lon, placeId, distanceMeters }` where **exactly one of `lat`/`lon` or `placeId` is set**: Photon returns positions, Google returns `placeId`s to resolve with `/geocode/place`. `session` (≤36 URL-safe chars) is Google's billing session token; `lat`+`lon` bias results toward that point. `limit` caps at 50 (default 8; Google itself returns at most 5). Never fails on a backend outage; returns `{ places: [] }`. |
| `GET /geocode/place?id=&session=` | Position of a search result that came with a `placeId`: `{ location: { lat, lon } \| null }`. Call once, for the result picked, with the same `session` its searches used. |
| `GET /geocode/reverse?lat=&lon=&lang=` | Nearest address to a coordinate, same backend. Returns `{ place: null }` when nothing is found or the backend is unreachable. |
| `GET /stops/:stopId?lang=` | Name, code, coordinates, `locationType`, resolved parent station, child stops when it is itself a station, and the routes serving it. |
| `GET /stops/:stopId/departures?at=&window=&limit=&includeSiblings=&toLat=&toLon=&lang=` | Departure board. `window` minutes, default 60, cap 180. `includeSiblings` merges a station's child platforms into one board. Looks back one service day so a trip still running past midnight from yesterday still appears. An **unknown stop id is a `404` regardless of `includeSiblings`**; a stop that exists but has nothing in the window is a `200` with an empty list. Ordered by absolute time, which is not the same as ordering the rendered strings on a DST-transition night (see [Service days](docs/how-it-works.md#service-days-and-the-midnight-rule)). Every row carries `lineCode`/`lineDirection` (the key `GET /lines/:lineCode` and its direction toggle use) and a `realtime` field (see [Realtime](#realtime-siri-sm) below). `toLat`/`toLon` filter the board to the runs that reach a destination **without changing**: given together or not at all (a `400` otherwise), they name a POINT, and any stop within 500 m of it counts as arriving there. A point rather than a stop id because the place a rider can name (a railway station, a mall) is almost never the stop beside it; the radius also reunites one physical station that the feed splits across several unrelated `parent_station` rows (Hadera's central station is four of them over ~111 m), which sibling kinship alone cannot. A point with no stop near it is a `200` with an empty list, not a `404`: the place exists, the buses do not. **The filter runs before `limit` truncates**, or a stop with fifty departures an hour and one useful run would answer "nothing goes there". Each surviving row gains a `destination` object: the `stopId` it actually calls at (the nearest one it serves, ties going to the earlier call), `name` (that stop's name in the asked language), `walkMeters` left from there, `rideSeconds` on board, and `arrivalTime`, the row's boardable instant plus the scheduled ride, so a late bus arrives late. There is no separate prediction for a stop further down the line, so the delay the bus already carries is the only evidence available. `nextDeparture` is always `null` under this filter: that lookahead answers "is this stop served", a question about the stop, and the run it finds need not go where the rider asked. |
| `GET /segments?from=&to=&after=&results=&lang=` | Every trip serving the exact stop pair `from` → `to`, in that order, ordered by departure: the "what else gets me from here to there" list a client shows when a transit leg is expanded. A lookup over the in-memory RAPTOR index, not a re-plan of the segment: no headway margin, no reachability. `from`/`to` are GTFS stop ids; `from === to` is a `400`, an unknown id is a `404` (same convention as `/trips/:id`). `after` defaults to now. `results` default 10, cap 50, **not** a time window: each candidate (pattern, boarding position, alighting position) contributes up to `results` trips on its own, so a low-frequency pair (e.g. an intercity rail segment queried mid-morning) still gets its next departures instead of an empty list just because they are hours away. Looks back one service day, same as the departures board. A pair with no service returns `200` with an empty list. Before the index has finished its first build, answers `503` with `code: "index_not_ready"`, same as `/plan`. |
| `GET /routes?agency=&type=&q=&limit=&offset=` | 7,605 lines; `limit` caps at 100 (default 50), `offset` for pagination. Returns `{ routes, total }`. |
| `GET /routes/:routeId?lang=` | The line, its directions, and each direction's ordered stop list from a representative trip. |
| `GET /routes/:routeId/shape?direction=` | GeoJSON `LineString` decoded from the stored precision-6 polyline. A trip with no `shape_id` (**every rail trip in the feed, 100% of `route_type` 2**) is drawn along its baked OpenStreetMap track instead, with `geometryFallback: false` (see [Train track lines](docs/how-it-works.md#train-track-lines)). Anything else without a shape, or a rail pair missing from the bake, falls back to a stop-to-stop line with `geometryFallback: true`: flagged, never silently faked. |
| `GET /routes/:routeId/trips?limit=&lang=` or `?stopId=&around=&limit=&lang=` | A line's runs, each carrying `runId`, `unscheduled` and `offsetSeconds` (`0` for a timetable run; see [Realtime](#realtime-siri-sm) below for the unscheduled ones). Default mode: the next `limit` runs (cap 20, default 6) departing the route's own first stop, timetable only, looked ahead up to a week for a line that skips today (e.g. Shabbat). `?stopId=&around=` instead times runs at one stop, for a rider who tapped a departure on a station board: the run just before `around` (a `tripId`), that run itself, and up to `limit` runs after it. `stopId` and `around` are given together or not at all (`400` otherwise), and an unknown trip id, or one that does not call at `stopId` in the probe window, answers `{ runs: [] }` rather than a guess. |
| `GET /routes/:routeId/vehicles` | Every bus currently on this route, for a line's own map: same response shape, freshness gate and "200 with an empty list" contract as [`/vehicles`](#realtime-siri-sm) below; never a `404`. |
| `GET /trips/:tripId?lang=` | One trip's full stop-by-stop timetable. Each stop carries **both** raw GTFS `arrivalSeconds`/`departureSeconds` (unclamped; >86400 is real) **and** ISO `arrivalTime`/`departureTime`. A GTFS trip carries no date (it repeats on every date its service is active), so the ISO values are rendered against `serviceDate`, the **next date on or after now on which this trip's service actually runs**, named explicitly in the response. Past the end of the service's calendar range `serviceDate` and every ISO field are `null` and only the raw seconds remain. |

### Planning

```
GET /plan?from=32.0836,34.7981&to=31.7883,35.2028&departAfter=2026-08-24T08:00:00+03:00&lang=en
```

`GET`, not `POST`: cacheable, and debuggable from a browser or curl.

| Parameter | Default | Notes |
| --- | --- | --- |
| `from`, `to` | required | Each is `lat,lon` or `stop:<stopId>`. A `stop:` endpoint skips the walking access/egress leg entirely. |
| `departAfter` / `arriveBy` | `departAfter=now` | Exactly one of the two; passing both is a `400`. ISO-8601 datetime, any timezone offset. |
| `maxWalkMeters` | `1000` (the `WALK_MAX_METERS` config default) | Cap 2500. For a coordinate endpoint, enforced against a real routed walking distance from Valhalla, not a straight line (see the `422`s below), falling back to the straight-line × 1.35 estimate only when Valhalla is down, times out, or returns something unparseable. |
| `maxTransfers` | `4` | Cap 6. |
| `results` | `5` | Cap 10. RAPTOR's Pareto set over (arrival time, transfers) is typically 2–5 itineraries; a shorter result list means fewer itineraries exist, not that the search was truncated. |
| `modes` | all | Comma-separated GTFS `route_type` values to filter by, e.g. `modes=0,3`. Strictly validated: anything that is not a comma-separated list of integers is a `400` naming the offending value. In particular a bare `modes=` is an error, **not** "no filter"; omit the parameter entirely for that. (`Number("")` is `0`, so an empty value used to mean "tram only", and `modes=abc` used to return `200` with zero itineraries.) |
| `wheelchair` | `false` | Filters on `trips.wheelchair_accessible`. |
| `lang` | `he` | |

A date outside the feed's calendar window returns a `422` rather than
`200 { itineraries: [] }`, because an empty array would be indistinguishable
from "genuinely unreachable". It arrives in the shared
[error envelope](#errors), carrying this value in `code`:

- `date_outside_service_window`: the requested date falls outside the
  feed's calendar window (the live feed only ever holds ~30 days).
  `details.serviceWindow` names the actual bounds.

**Nearest-stop fallback.** A coordinate endpoint's candidates are filtered by
`maxWalkMeters` twice: first a straight-line prefilter, then the same cap
again against the real routed walking distance (a straight line can
understate a walk that has to go around a motorway or a rail corridor). If
either stage leaves an endpoint with nothing, the planner does **not** 422:
it re-tries with the 5 nearest stops by straight-line distance, with
`maxWalkMeters` lifted entirely for them, and plans from there. Several
candidates, not just the single nearest, because the literal closest stop
can be the one sitting across the motorway; a slightly farther one is often
the genuinely walkable one. The resulting walk leg reports its **true**
distance and duration, which may be many kilometres, honestly labelled
(`walkEstimated: true` when Valhalla was down for that call) rather than
clamped to the cap it was let past.

**That leg no longer guarantees the itinerary survives**, and this paragraph
used to claim it did. Effort ranking's two filters run after the search and
apply to fallback itineraries like any other (see
[Ranking and filtering](#ranking-and-filtering)):

- An itinerary with **no transit leg at all** is dropped unconditionally. A
  fallback that ends up walking the whole way is exactly that shape, so it is
  now deleted rather than returned: the response is `200 { itineraries: [] }`
  instead of a multi-kilometre walking suggestion.
- An itinerary whose walking exceeds `PLAN_MAX_WALK_SHARE` (default 0.7) of
  its own duration is dropped too, so a very long fallback walk attached to a
  short ride can go the same way. Set `PLAN_MAX_WALK_SHARE=1.0` to disable
  that one; the walk-only drop has no off switch by design.

The fallback still does its job (it is what lets a stop 1.4 km away anchor a
real transit journey instead of 422ing), but "the walk is honestly labelled"
is now a statement about the leg, not a promise about the response.

This applies per endpoint, independently, and only to a
coordinate endpoint. `stop:<id>` never reaches this: an unknown id is its
own `404 not_found` (`No stop with id <id>`, same convention as `/trips/:id`
and the rest), thrown before the fallback or the walking-cap 422 below could
misreport a typo'd id as a distance problem; there is no walk to measure
when the id itself does not exist.

`no_stops_near_origin` / `no_stops_near_destination` remain defined as
codes, but after this fallback they are reachable only when:

- the loaded feed has no stops at all, or
- Valhalla resolves the fallback's own (uncapped) matrix call but reports
  **every one** of the 5 nearest candidates as unreachable on foot (no
  pedestrian path at all, not merely "too far"): a coordinate offshore,
  inside a fenced-off zone, or on a road with no pedestrian access.

A pair that was genuinely searched but found no itinerary returns
`200 { itineraries: [] }`.

Before the index has finished its first build, `/plan` answers `503` with
`code: "index_not_ready"` and `Retry-After: 5`.

**`departureTime`/`arrivalTime` are door-to-door.** They are anchored on the
whole chain, including any leading/trailing walk leg, not on the first or
last *transit* leg. A `WalkLeg` carries no timestamp of its own, so these
are the only fields a client can read to learn when the chain begins and
ends. They will differ from `legs[0].from.departureTime` whenever the
itinerary begins or ends with a walk. See the schema `description` on
`/plan` in [`src/routes/plan/schema.ts`](src/routes/plan/schema.ts) for the full reasoning;
this was an explicit, adjudicated design call, not an oversight (the plan
originally anchored on the transit legs, which is a real bug: it cannot
report a door departure time when the itinerary starts with a walk).

**`departureTime` is the latest feasible door departure in both modes.**
`arriveBy`'s reverse search maximises departure directly. `departAfter`'s
single-pass forward search does not (it only minimises arrival from a
fixed start, so the raw chain begins at the query instant itself), but the
handler re-anchors the result on the first transit leg's own boarding time
(less any walk before it), then re-runs the existing reverse search
backwards from that same arrival to check whether an even later departure
still reaches it in exactly as many transfers. A 03:00 query answered by an
08:00 bus now reports `departureTime` at (or after) 08:00, not 03:00, and
`durationSeconds` is the real ride time, not a duration padded with five
hours of platform waiting. `arrivalTime` is the real door arrival in both
modes, and for `departAfter` it is always the earliest reachable arrival;
re-optimising the departure never moves it.

**Two `arriveBy` results are discarded rather than returned**, because
nothing else in the reverse search bounds how far back it may reach:

- a journey that "arrives by" the deadline only by arriving **more than 24 h
  before** it;
- a journey holding a single wait **longer than 12 h between two consecutive
  transit legs**: you did not "connect", you spent the night at the
  junction. The bound is on that one gap, not on total duration: on this
  branch `durationSeconds` is deadline-anchored whenever the chain ends in a
  footpath, so a duration bound rejects perfectly ordinary journeys (it did,
  and was removed). The 12 h figure is measured, not guessed: of 629
  itineraries sampled from the live feed, none fell between 11 h and 12.8 h,
  so the threshold sits in an empty band rather than through a cluster.

The wait bound only applies when `TRANSFER_HEADWAY_FACTOR` is non-zero. It
exists because the margin is what makes the reverse search reach past a
same-day connection in the first place, and `TRANSFER_HEADWAY_FACTOR=0` must
restore the pre-feature planner exactly, discards included. One consequence
follows from the never-empty guarantee below: if discarding the
long-wait journey leaves the response *empty*, the query-level retry runs at
the flat rule (where the bound is gated off) and hands that journey back
after all. The bound's real job is keeping an overnight fallback out of a
result that has better journeys in it, and it still does that.

The 12 h wait bound also applies to the `departAfter` reverse probe described
below, which builds reverse chains of exactly the same shape and can stitch
one across a half-day gap in sparse service. The 24 h lookback bound does not
need to: a probe candidate departing before the query instant is already
discarded outright, which is strictly stronger.

### Ranking and filtering

`/plan` orders its answers by **rider effort**, not by arrival time, and
drops two shapes of answer outright. Both are new on this branch and both are
visible in the response.

**Ordering.** Each itinerary is scored

```
cost = durationSeconds
     + walkSeconds       × (PLAN_WALK_WEIGHT − 1)
     + originWaitSeconds × PLAN_ORIGIN_WAIT_WEIGHT
     + PLAN_TRANSFER_PENALTY_SECONDS × transfers
```

and the list is sorted by that, ascending, with departure time as a stable
tiebreak. `durationSeconds` is measured from the itinerary's own re-anchored
departure, so the wait before it is not in the duration at all;
`originWaitSeconds` is that wait, measured from the **earliest feasible
departure among the answers** rather than from the requested time. A rider
whose first option leaves in forty minutes is not charged forty minutes on
every candidate, only for choosing to leave later than they had to.

**Waiting is cheaper than riding, not free.** At the default `0.5` a waiting
second costs half a riding one. It was free originally, which is what lets a
later, easier journey beat an earlier, harder one, and still does when the
wait buys something: twenty-three minutes of waiting to save fourteen minutes
of walking is a trade riders make, and the ordering keeps making it. What free
waiting could not see is a later journey that buys *nothing*: same walking,
same transfers, five minutes shorter in the vehicle, arriving twenty-four
minutes later. `PLAN_ORIGIN_WAIT_WEIGHT=0` restores the free-waiting ordering
exactly.

**Transfers are no longer the primary sort key**: a one-transfer twelve-minute
journey now outranks a zero-transfer twenty-minute one. A client that relied on
"fewest transfers first" needs updating.

**The departure window.** So that a five-minute ride three hours from now
cannot bury a perfectly good journey leaving shortly, a `departAfter` journey
departing more than `PLAN_DEPARTURE_WINDOW_SECONDS` after the **earliest
feasible departure** is still listed but can never be promoted above one
inside that window. Anchoring on the earliest *feasible* departure rather than
on the requested time is what keeps the sparse case working: ask at 11:16 when
nothing runs until 14:00 and the window becomes 14:00–14:30, not an empty
list. The window is **not** applied on `arriveBy` (with the arrival pinned, a
later departure is unambiguously better) nor to the extra reverse probe below,
whose arrival is already bounded.

**One extra search.** A forward earliest-arrival search cannot see a journey
that departs later *and* arrives later, however much less effort it is. So
`departAfter` also runs one reverse search at a relaxed deadline (the
earliest arrival plus the window), which yields the latest-departing journey
per transfer count. It is a fixed cost, independent of how wide the window is.
`PLAN_REVERSE_PROBES` raises it to 2 or 3 interpolated deadlines if real
queries turn out to lose *middle* departures.

**Two filters, applied after the search.**

- **No transit leg → dropped, unconditionally.** A stop inside both the origin
  and destination walk radius made "walk, walk, walk" reachable with zero
  boardings, reported as `transfers: 0`. A point pair with no transit between
  them now returns `200 { itineraries: [] }` rather than a walking route. This
  has no off switch by design.
- **Walking above `PLAN_MAX_WALK_SHARE` of the duration → dropped.** A
  backstop against the pathological tail only; the cost function is what
  demotes walk-heavy journeys in the ordinary case. At the 0.7 default this is
  deliberately stricter than a shipping transit app. `PLAN_MAX_WALK_SHARE=1.0`
  turns it off.

Neither filter triggers the never-empty retry described below; that
guarantee is about the *search*, and a journey the flat margin would find is
one these filters would drop again.

**Turning the cost function off.** `PLAN_WALK_WEIGHT=1` with
`PLAN_TRANSFER_PENALTY_SECONDS=0` collapses `cost` to `durationSeconds`,
restoring duration ordering exactly. It is a **cost-function off switch, not a
feature off switch**: the extra reverse search still runs and both filters
still apply, so the response is not byte-identical to a build without this
feature.

### Active journey check

```
GET /journey/check?leg=T1,1000,2000&leg=T4,2000,5000&at=2026-08-24T08:05:00+03:00&lang=en
```

For a rider already partway through a journey: given the REMAINING legs (as
`leg=<tripId>,<fromStopId>,<toStopId>`, repeated, in journey order, 1–12 of
them), reports what each leg does now and whether each connection between
them still holds, without re-planning. A broken connection is reported, not
routed around; choosing what to do about it is the frontend's job. Stateless:
nothing here is stored between requests, and the response carries no
`stop_ref`/`trip_ref`, only public GTFS ids.

`at` (default now) picks the service day: the same (current day, previous
day) pair `/plan` and `/segments` use, so a leg running past midnight (GTFS
times legitimately exceed 86400 here) resolves correctly. Unlike a RAPTOR
search, this endpoint has no forward pass to establish which of the two days
is right when a trip is active on both (a Sun–Thu service checked on a
Monday, say): it picks whichever day's resulting boarding instant is nearer
`at`, after first discarding any day whose instant falls more than six hours
BEFORE `at` ITSELF as stale. Measured from `at`, not from `at`'s calendar
day. An earlier version of this rule measured it from midnight, which threw
out the one case the nearest-instant rule exists for: a leg boarded 23:30 and
checked at 00:00:01 the same night, on the very trip the rider is sitting on,
was discarded for landing "yesterday" by calendar date. A
trip inactive on every day near `at` (a stale client, or a date outside the
feed's window) is a `422` (`trip_not_active`) naming the trip, never a `200`
with a plausible-looking wrong-day time.

`requiredSeconds` on each connection is the **same** headway-scaled boarding
margin [`/plan` itself requires](#the-headway-scaled-transfer-margin) before
it will build that connection, reused, not reimplemented, so a connection
can never read as holding when the planner would have refused it. It always
uses the margin's more conservative (reverse-pass, maximum-over-window)
form, because this endpoint has no way to know which of `/plan`'s two RAPTOR
passes actually built the itinerary a chain came from, and that form is
never smaller than the other at the resulting instant; measured against the
real feed, the two agree 96.82% of the time, and where they differ the mean
margin rises by only 4.3 s. It covers the boarding margin only, never the
walk between two legs; the frontend already knows its own itinerary's walk.

`slackSeconds` and `holds` are always computed from the same arrival instant:
whichever one `holds` was actually decided against (the schedule when it
alone already falls short, the realtime prediction otherwise), so a client
checking `slackSeconds >= requiredSeconds` on its own can never disagree with
the server's own verdict.

`holds` is three-valued, per connection and overall: `true` the connection
is fine, `false` it is broken, `null` when this cannot be said (no realtime
configured, or a delay never reported), **never collapsed into `false`**,
since that would tell a rider their connection is broken exactly when the
service simply does not know. The overall `holds` is `false` if any
connection is `false`, `null` if any is `null` and none is `false`, else
`true`, including the trivial single-leg case (no connection to break).

Reject `400`: no `leg` at all, more than 12 of them, a `leg` not exactly
three comma-separated ids, or a trip whose own stop sequence does not
include both ids in order (a malformed chain, distinguished from a broken
connection; the latter is a legitimate `200 { holds: false }`). Reject
`404`: an unknown trip or stop id, naming which. Before the index has
finished its first build, answers `503` with `code: "index_not_ready"`, same
as `/plan`.

### Re-planning from aboard

```
GET /plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=2026-08-24T08:05:00+03:00&delaySeconds=900
```

The other half of active-journey mode. [`/journey/check`](#active-journey-check)
tells a rider their connection has broken; this answers the next question:
**given where I am right now, what is the best way on from here?** The bus is
late, the rider is aboard it, the train they were going to catch is gone: this
finds the next one, or notices that staying aboard two stops further catches a
different train sooner.

| Parameter | Default | Notes |
| --- | --- | --- |
| `onTrip` | required | The trip the rider is riding. Unknown id → `404`. |
| `onTripFromStop` | required | The stop they last passed or boarded at. Everything **after** it on that trip is somewhere they can get off. Unknown id → `404`; a stop the trip does not serve, or its **last** stop (nowhere left to alight), → `400`. |
| `to` | required | `/plan`'s place syntax: `lat,lon` or `stop:<id>`. |
| `at` | now | The current instant. Picks the service day. |
| `delaySeconds` | `0` | How late the vehicle is running, signed. Ignored when the realtime feed has data for this trip. |
| `maxWalkMeters`, `maxTransfers`, `results`, `modes`, `wheelchair`, `lang` | as `/plan` | Exactly `/plan`'s meanings and defaults. |
| `arriveBy` | n/a | `400`. A journey cannot be re-planned backwards out of a vehicle already moving. |

It is a **seeding** change, not a second planner. `runRaptor` already takes
`origins` as `(stop, secondsToReach)` pairs offset from the query instant, so
"I am aboard this bus" is exactly "I can be at stop X in N seconds, for every
X the bus still serves": one origin per remaining stop, timed at that stop's
scheduled arrival plus the delay. Everything else falls out: staying aboard
longer is a later seed, getting off early is an earlier one, and a delay
shifts every seed together. A stop the vehicle has **already** passed is not
seeded (the rider cannot get off behind themselves), so a bus running later
than the client believes simply has fewer ways off it.

The response is `/plan`'s itinerary shape, unchanged, plus per itinerary:

```json
"alightAt": { "stopId": "5000", "name": "…", "arrivalTime": "2026-08-24T08:20:00+03:00" }
```

It says where the rider leaves the vehicle they are on, and when it gets there.
Without it a client cannot tell "get off at the next stop" from "stay aboard
four more stops", which is this endpoint's most useful output. An itinerary's
`departureTime` is that same alighting instant, **not** a door departure and
not the next boarding: the rider's departure is not theirs to choose. Top
level, `delaySource` is `"realtime"`, `"client"` or `"schedule"`, saying which
timing the answer was actually built on, and `query.delaySeconds` echoes the
delay actually applied.

**The first boarding here IS charged the transfer margin**, unlike `/plan`.
[The margin](#the-headway-scaled-transfer-margin) exempts a journey's first
boarding because a rider walking from their own front door has no
incoming vehicle that could be late. Here there is one, and it is the entire
point of the endpoint, so leaving the exemption in place would waive the
margin on precisely the connection the rider is at risk of missing. RAPTOR
decides this by a label's **provenance**, not its kind, and a query-level
`originsOnVehicle` flag is what tells it these particular origins are riders
already aboard. An onboard connection is therefore charged exactly what the
same connection would be charged mid-itinerary, flat buffer included, and
`TRANSFER_HEADWAY_FACTOR=0` still restores the pre-headway rule exactly.

**`transferAtRisk` covers the first boarding here, and `/plan`'s own checks
cannot.** Both of those walk transit-leg-to-transit-leg pairs, and the vehicle
the rider is aboard is not a leg of the itinerary, so the one connection this
endpoint's margin treatment exists to protect is invisible to them. Two things
can still hand back a first boarding the rule would have refused: the
[per-connection fallback](#the-headway-scaled-transfer-margin) at
the last service of the day, and the query-level retry that re-runs at the
flat rule rather than return nothing at all. In both cases this endpoint
prices the alight→board gap itself, with the same `requiredMarginFor` the
planner used, and raises `transferAtRisk`, so a recovered journey is offered
*flagged*, never as an unmarked `null` and never as an affirmative `false`
just because a realtime feed happened to confirm the connections further down
the chain. It only ever raises the flag: a first boarding that genuinely
clears the margin is left alone.

An empty `itineraries` list is a legitimate answer, not an error. A trip with
no active service day near `at` is a `422` (`trip_not_active`), the same
convention `/journey/check` uses, and, as there, a rider aboard **after
midnight** resolves against the day their trip actually belongs to rather than
being wrapped, which for this endpoint is an ordinary case rather than an edge
one. Stateless; no `stop_ref`/`trip_ref` in the response.

### The headway-scaled transfer margin

The buffer `/plan` requires before boarding scales with the next headway of the service being boarded: `clamp(TRANSFER_MIN_SECONDS, TRANSFER_HEADWAY_FACTOR * headway, TRANSFER_MAX_SECONDS)`. With the defaults that is 60 s on a frequent line and up to 600 s on a sparse one. `TRANSFER_HEADWAY_FACTOR=0` turns it off. How each pass applies it, the last-service fallback, and the measurements behind the defaults are in [docs/transfer-margin.md](docs/transfer-margin.md).

### Realtime (SIRI-SM)

Live predictions are annotated onto `/plan`'s transit legs and onto departure-board entries. With `MOT_SIRI_KEY` and `MOT_SIRI_BASE_URL` both set they come from the Ministry of Transport's SIRI-SM feed; without a key, from a keyless feed chosen by `REALTIME_KEYLESS_SOURCE` (`open-bus` by default, `stride` or `off`). The fields, how predictions are derived and matched, and how the planner searches on live delays are in [docs/realtime.md](docs/realtime.md).

## Configuration

Parsed in [`src/config.ts`](src/config.ts) with eager, fail-loud validation:
an invalid value throws at process start, naming the bad value, rather than
silently reconfiguring a safety gate.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3100` | Deliberately not 3000: `gtfs` owns that, and both run locally. |
| `HOST` | `0.0.0.0` | |
| `NODE_ENV` | `development` | `production` enables `trustProxy` and disables pretty logging. |
| `LOG_LEVEL` | `info` | |
| `TRANSIT_ADMIN_TOKEN` | *(unset)* | Shared secret required by `POST /admin/reload`, presented as `Authorization: Bearer <token>` and compared in constant time. **Unset means the route refuses every request**, not that authentication is off (see below). |
| `TZ` | `Asia/Jerusalem` | Timezone used for service-day boundaries and ISO timestamp rendering. Validated at boot against the IANA zone database; a typo fails loudly rather than shifting every service day by hours in silence. **Caveat this cannot check:** it piggybacks on the POSIX `TZ` variable, which container runtimes, CI images and schedulers set for their own reasons, and `TZ=UTC` is a perfectly *valid* zone, so it passes validation while moving every boundary three hours. If service days look wrong on a new platform, check what the platform set `TZ` to. |
| `GTFS_DATA_DIR` | `<repo-root>/data` | Anchored on `config.ts`'s own module location, not `process.cwd()`; resolves to the same directory regardless of launch directory, matching `gtfs`'s own resolution so the two services never disagree about where the database lives. |
| `TRANSIT_CACHE_DIR` | `<repo-root>/cache` | The footpath cache (see below). Deliberately **not** inside `data/`, which `gtfs` garbage-collects. |
| `TRANSIT_RELOAD_POLL_MS` | `60000` | How often the `gtfs.sqlite` symlink target is re-checked. |
| `VALHALLA_URL` | `http://localhost:8002` | |
| `VALHALLA_TIMEOUT_MS` | `5000` | Per-request ceiling; a timeout degrades that call, it does not fail the request. |
| `VALHALLA_BATCH_SIZE` | `50` | Matrix chunk size for the footpath precompute. |
| `PHOTON_URL` | `http://localhost:2322` | |
| `PHOTON_TIMEOUT_MS` | `5000` | Per-request ceiling; a timeout degrades that call to an empty result, it does not fail the request. |
| `GEOCODER` | `photon` | `photon` or `google`: who answers `/geocode/*`. Anything else fails at boot. |
| `GOOGLE_MAPS_API_KEY` | *(unset)* | Required when `GEOCODER=google` (boot fails without it). Needs Places API (New) and Geocoding API enabled. |
| `GOOGLE_MAPS_TIMEOUT_MS` | `3000` | Per-request ceiling, same degrade-don't-fail contract as Photon. |
| `GOOGLE_MAPS_DAILY_REQUEST_LIMIT` | `3000` | Billable Google calls (autocomplete + place + reverse) per UTC day before `/geocode/*` returns nothing until midnight. Per process; `0` disables. A backstop; set real quotas on the key too. |
| `WALK_MAX_METERS` | `1000` | Also the straight-line prefilter radius for candidate footpaths (min 1, max 10000). |
| `WALK_SPEED_MPS` | `1.33` | Straight-line fallback only; a real Valhalla walk uses its own pedestrian costing. The 1.35× detour factor applied on top is a single exported constant (`WALK_DETOUR_FACTOR` in `src/walking/valhalla.ts`), not a per-call-site literal, so two straight-line-estimated numbers on the same leg never disagree about how far the walk is. A leg mixing a real, Valhalla-routed field with an estimated one is a different case; see [Known limitations](#known-limitations) item 3. |
| `TRANSFER_MIN_SECONDS` | `60` | Floor of the boarding buffer added to every transfer, walking or same-station; see [The headway-scaled transfer margin](#the-headway-scaled-transfer-margin) below for how it combines with the next two settings. |
| `TRANSFER_HEADWAY_FACTOR` | `0.25` | Fraction of the boarded pattern's own headway required as boarding buffer. A **clamp, not an addition**: the scaled figure replaces `TRANSFER_MIN_SECONDS`, which is only its floor, so a 2-minute headway asks for 60 s (the floor) rather than 90 s. `0` is a genuine, tested off switch: with it set, `/plan` returns results **byte-identical** to a build without this feature at all, verified directly against `main` across 20 real queries, and again across 482 random queries after the last-service rule landed (see below). Must be `>= 0`; refused at boot otherwise, because a negative value would make boarding easier than the flat rule, which nothing in this codebase is allowed to do. |
| `TRANSFER_MAX_SECONDS` | `600` | Ceiling on the same buffer, so an hourly service does not demand half an hour of margin. Must be `>= TRANSFER_MIN_SECONDS`; refused at boot otherwise. |
| `SAME_STATION_TRANSFER_SECONDS` | `180` | Platform-to-platform interchange at a station; never street-routed. |
| `PLAN_REOPTIMISE_MAX_ITINERARIES` | `3` | How many of a `/plan` response's itineraries get the departure *reoptimisation* pass (a second reverse RAPTOR search each). Range 0–10. Every itinerary is still **re-anchored** on its own first boarding regardless; the bound only skips the further "could I leave even later?" refinement, never returns an itinerary to reporting the query instant. The cost is superlinear in the number of Pareto members actually returned (measured warm on the live feed: 107/136/206/321/453/590 ms for 1–6 members), so unbounded a long inter-city query ran 273–453 ms against the then-standing flat 250 ms budget; bounded at 3 the same queries are ~200 ms and latency is flat in `results`. That flat budget has since been replaced by one that scales with Pareto members returned; see `config.ts`'s own comment on this key. |
| `PLAN_WALK_WEIGHT` | `2.0` | What a walking second costs relative to a riding second in `/plan`'s effort ordering (see [Ranking and filtering](#ranking-and-filtering)). Range 1.0–5.0; refused at boot outside it. `1.0` makes them equal, which is the pre-feature ordering. |
| `PLAN_TRANSFER_PENALTY_SECONDS` | `300` | Flat cost added per interchange, on top of the wait it already implies through `durationSeconds`. Range 0–3600. Set together with `PLAN_WALK_WEIGHT=1` **and `PLAN_ORIGIN_WAIT_WEIGHT=0`** this collapses the cost to `durationSeconds`: a **cost-function** off switch, not a feature off switch: the extra reverse pass still runs and both filters still apply. |
| `PLAN_DEPARTURE_WINDOW_SECONDS` | `1800` | How far past the **earliest feasible departure** a `departAfter` journey may depart and still be ranked purely on cost; a later one is listed but never promoted above an in-window one. Range 0–21600. Anchored on the earliest *feasible* departure, not on the requested time, so a query hours before the first service still returns that service. Not applied on `arriveBy`, nor to the reverse probe (already bounded on arrival). Also the deadline offset the probe itself searches at. |
| `PLAN_ORIGIN_WAIT_WEIGHT` | `0.5` | What a second spent waiting at the origin costs relative to a riding second in `/plan`'s effort ordering (see [Ranking and filtering](#ranking-and-filtering)). Measured from the **earliest feasible departure among the answers**, not from the requested time. Range 0.0–1.0; refused at boot outside it. `0.0` prices waiting at nothing, which is the ordering before this term existed; `1.0` makes a waiting second cost a riding one, collapsing the order to arrival plus the walking and transfer terms. Not applied on `arriveBy` (with the arrival pinned, a later departure is *less* waiting) nor by `/plan/onboard` (a rider already aboard has no origin to wait at). |
| `PLAN_MAX_WALK_SHARE` | `0.7` | Fraction of an itinerary's own `durationSeconds` that may be walking before it is dropped outright. Range 0.0–1.0; `1.0` disables the cap. A backstop against the pathological tail only; the cost function is what demotes walk-heavy journeys in the ordinary case. Deliberately stricter than a shipping transit app at the default. The companion drop, an itinerary with **no transit leg at all**, has no knob by design. |
| `PLAN_REVERSE_PROBES` | `1` | How many reverse RAPTOR probes the `departAfter` branch runs, at evenly spaced deadlines up to `earliestArrival + PLAN_DEPARTURE_WINDOW_SECONDS`. Range 1–3; **it cannot be switched off**; one probe is what makes a later-departing, lower-effort journey visible at all. Each increment is another full reverse search on every request; raise it only if real queries are shown to lose *middle* departures. |
| `PLAN_RATE_LIMIT_PER_MINUTE` | `60` | Per-**client-IP** requests/minute `GET /plan` answers before `429`ing, layered on top of the global 300/min limit: `/plan` runs a RAPTOR search per request and is the expensive endpoint on this box, so it gets its own tighter budget. Range 1–10,000. `@fastify/rate-limit` keys on `request.ip`, and Israeli carrier-grade NAT puts many real riders behind one address; the default assumes roughly 60 concurrent watchers per address, since the app polls an open results screen once a minute (`PLAN_REFETCH_INTERVAL_MS` in `app/src/api/plan.ts`). If real users start seeing `429`s, raise this; don't remove it. |
| `JOURNEY_CHECK_RATE_LIMIT_PER_MINUTE` | `120` | Per-**client-IP** requests/minute `GET /journey/check` answers before `429`ing, same layering as `PLAN_RATE_LIMIT_PER_MINUTE`. Range 1–10,000. This route is **polled**, not event-driven: the app re-checks an active journey every 30 s (`JOURNEY_CHECK_POLL_MS` in `app/src/features/journey/use-journey-live.ts`), i.e. 2 requests/minute per rider, so 120 is roughly 60 concurrent journeys behind one carrier address. It also serves a rider **mid-journey**: a `429` here breaks a connection-holds check for someone actually travelling, which is why the ceiling is generous and raising it (not removing it) is the right response to real-rider `429`s. |
| `PLAN_ONBOARD_RATE_LIMIT_PER_MINUTE` | `60` | Per-**client-IP** requests/minute `GET /plan/onboard` answers before `429`ing, same layering as `PLAN_RATE_LIMIT_PER_MINUTE`. Range 1–10,000. This route is **event-driven**, not polled (it fires once when a rider aboard a vehicle asks to re-plan), but runs the same RAPTOR-search cost shape as `/plan`, so it shares `/plan`'s budget rather than a different one. Like `/journey/check`, it serves a rider **mid-journey**, so its ceiling is generous for the same reason. |
| `SEGMENTS_RATE_LIMIT_PER_MINUTE` | `120` | Per-**client-IP** requests/minute `GET /segments` answers before `429`ing, same layering as `PLAN_RATE_LIMIT_PER_MINUTE`. Range 1–10,000. This route is **user-initiated** (a rider expands a transit leg) and, per its own row above, a **lookup** over the in-memory RAPTOR index rather than a re-plan, cheaper than `/plan` or `/plan/onboard` per request, so it affords a higher ceiling. |
| `MOT_SIRI_KEY` | *(unset)* | The `Key` issued by the Ministry of Transport for its SIRI-SM realtime feed. **Unset disables realtime entirely** (see [Realtime](#realtime-siri-sm) below). Never logged, never echoed in a response or error; if you write this into a `.env` or a command line, treat any value shown elsewhere as a placeholder, never a real key. |
| `MOT_SIRI_BASE_URL` | *(unset)* | The base address from the same MOT registration. Realtime is enabled only when **both** this and `MOT_SIRI_KEY` are set and non-empty; one set without the other is a misconfiguration that logs a warning and stays disabled, not a half-enabled state. |
| `REALTIME_POLL_SECONDS` | `30` | Poll interval for the `AllActiveTripsFilter&calls` stream (vehicles mid-trip). Range 15–3600; the floor of 15 is the ICD's own rate limit on this feed. |
| `REALTIME_PLANNED_POLL_SECONDS` | `60` | Poll interval for the `AllPlannedTripsFilter` stream (trips not yet under way, departing within 4h). Same 15–3600 range. |
| `REALTIME_MAX_AGE_SECONDS` | `180` | A snapshot older than this is treated as absent everywhere it is read; stale predictions are worse than none. Range 1–3600. |
| `REALTIME_TIMEOUT_MS` | `20000` | Per-request ceiling on a SIRI snapshot fetch; a timeout degrades that poll tick, it does not fail a request. Range 1–600000. |

**These six are validated at boot even when realtime is off.** `resolveRealtimeConfig` runs at module load unconditionally, so a malformed
`REALTIME_POLL_SECONDS` (or any of the other four numeric settings above) fails
the whole process at start-up exactly like a bad `PORT` or `TZ` would, **even
on a deployment that never sets `MOT_SIRI_KEY` at all**. This is deliberate
(failing loudly on a real misconfiguration beats silently ignoring one), but it
is a genuine behaviour change on the no-key path: a stray
`REALTIME_POLL_SECONDS=abc` left over in an environment file that predates
this feature will now stop the service from booting, not just leave realtime
disabled. `MOT_SIRI_KEY`/`MOT_SIRI_BASE_URL` themselves have no such
validation; any non-empty string is accepted, since only the ministry knows
what a well-formed one looks like.

### Why `POST /admin/reload` fails closed

It is the only mutating endpoint on an otherwise read-only, permissively
CORS'd public API, and what it starts is a multi-hundred-megabyte index
rebuild, so an anonymous caller who could reach it could hold one running
continuously. `TRANSIT_ADMIN_TOKEN` gates it, and **an unset variable
refuses every request** rather than allowing all of them. An operator who
forgets to set it gets a reload endpoint that does not work, which they will
notice; the alternative default gets them one anyone on the internet can
drive, which they will not. The `401` is deliberately identical for "no
token configured", "no token presented" and "wrong token": distinguishing
them would tell an unauthenticated caller whether the deployment has a token
at all.

```
curl -X POST -H "Authorization: Bearer $TRANSIT_ADMIN_TOKEN" \
  http://localhost:3100/admin/reload
```

## Errors

**Every** non-2xx response in this service uses one envelope, so a client can
write one parser:

```json
{
  "statusCode": 422,
  "code": "date_outside_service_window",
  "message": "The loaded feed covers 20260821 to 20260920; 20261201 is outside it.",
  "requestId": "req-3",
  "details": { "serviceWindow": { "start": 20260821, "end": 20260920 } }
}
```

- `code` is the machine-readable half and the only field to branch on.
  `message` is for humans and its wording may change at any time.
- `details` is optional; its shape is documented per `code` (today only
  `date_outside_service_window` sets it).
- `requestId` is the Fastify request id, present on every error.

`/ready`'s **200** body (`{ ready, state }`) is a success body and is
unaffected; its 503 uses the envelope like everything else.

**A 4xx passes its own message through**: it is intentional and describes
what the caller got wrong. **A 5xx never does.** The real error is logged
server-side in full (stack, cause, driver code) against `requestId`, and the
client gets a fixed generic message plus that id. No SQLite code, no driver
text, no stack, and no filesystem path crosses that boundary. Report a 500 by
quoting its `requestId`.

"Every" includes the errors Fastify raises **before routing**: a URL
component that is not valid percent-encoding (`400 bad_url`) or a path
parameter past `maxParamLength` (`414 uri_too_long`). Those never reach a
route handler, so they are mapped through the `frameworkErrors` hook instead;
they keep their real status (a 414 is not flattened into a 400) and, like
every other code here, they are this API's own snake_case identifiers;
Fastify's internal `FST_ERR_*` names are never public.

Codes in use: `bad_request`, `bad_url`, `unauthorized`, `not_found`,
`conflict`, `rebuild_already_running`, `uri_too_long`,
`unprocessable_entity`, `rate_limited`, `internal_error`,
`service_unavailable`, `live_database_unavailable`, `index_not_ready`,
`date_outside_service_window`, `no_stops_near_origin`,
`no_stops_near_destination`.

## How it works

The RAPTOR index, atomic feed swaps, footpaths, train track lines and the service-day midnight rule are described in [docs/how-it-works.md](docs/how-it-works.md).

## Known limitations

Deliberate behaviours a caller should know about: line names are Hebrew regardless of `lang`, itinerary times are door-to-door, walk legs carry no `geometryFallback`, train lines follow OpenStreetMap track, `arriveBy` has a 24-hour lookback, a Valhalla outage degrades to straight lines, one rare RAPTOR suboptimality, and `/plan/onboard` names the earliest visit on a loop. Each is explained in [docs/known-limitations.md](docs/known-limitations.md).

## Testing

`npm test` runs `node --test` against a small synthetic GTFS fixture built
into a temp directory; it never opens the 666 MB live database and never
touches the network. It currently passes 550 tests, plus the one gated live
test reporting `skipped`. That includes the realtime suite
(`src/realtime/*.test.ts`): the SIRI parser, matcher, poller and store are
all exercised against fixture payloads and in-process HTTP stubs bound to an
ephemeral port, never against the real MOT endpoint, confirmed by running
the suite with the local Valhalla container stopped too, which changes
nothing about the result.

**The property/oracle tests are what actually protect the routing engine,
and this is not a hypothetical concern.** Review built independent
brute-force reference implementations of forward and backward RAPTOR and
ran them against the real implementation over tens of thousands of randomly
generated synthetic transit networks. That differential testing found
**six real defects in forward RAPTOR**, three of them Critical (a
departure-tie mishandled at the pattern level, per-day trip selection
comparing absolute epochs across different service days, and an
overtaking split that only considered departure order and missed arrival
crossings), plus further defects in the reverse (`arriveBy`) engine and in
itinerary reconstruction. **The eleven hand-written example tests that
existed before the oracle found none of them.** Do not delete or weaken
`raptor.oracle.test.ts` / `raptorReverse.oracle.test.ts` on the assumption
that the hand-written cases already cover correctness; they demonstrably
do not, on this exact codebase.

`npm run test:live` (`TRANSIT_LIVE_TEST=1`, see
[`src/plan.live.test.ts`](src/plan.live.test.ts)) builds the real index from
`data/gtfs.sqlite` and asserts the pattern count lands near the measured
6,901 and that late-night departures past 86,400 seconds survive unclamped.
It is gated behind `TRANSIT_LIVE_TEST=1` specifically so `npm test` stays
hermetic and safe to run without the real database present.

## Troubleshooting

- **`503 { "code": "index_not_ready" }` from `/plan` or `/ready`.** The
  RAPTOR index has not finished its first build (or is
  rebuilding after a feed swap). Poll `/ready` or `/meta`'s `index.state`;
  it resolves to `ready` within seconds under normal conditions. `/health`
  stays `200` throughout; use it to distinguish "process crashed" from
  "process alive, still warming up".
- **`422 { "code": "date_outside_service_window" }` from `/plan`.** The
  requested date falls outside the loaded feed's calendar window (the
  live feed spans only ~30 days). The response names the actual window in
  `details.serviceWindow`; `GET /meta`'s `serviceWindow` has the same bounds.
- **`401` from `POST /admin/reload`.** Either the token is wrong or
  `TRANSIT_ADMIN_TOKEN` is not set on the server; the two are deliberately
  indistinguishable from outside. Check the variable is set, then present it
  as `Authorization: Bearer <token>`.
- **`503 { "code": "live_database_unavailable" }` from `POST /admin/reload`.**
  The `gtfs.sqlite` symlink was absent at that instant, which is what the
  fetcher's publish window looks like from here. Transient: just retry.
- **`GET /meta` reports `"footpaths": "straight-line"`.** Valhalla was
  unreachable at the last footpath (re)attachment; check `docker compose ps`
  and `docker compose logs valhalla`. Remember the container's first start
  takes 10–20 minutes to build tiles, during which this is expected. Nothing
  needs manual intervention: `POST /admin/reload` (or the next scheduled
  reload, or a restart) retries Valhalla, and if it succeeds the result is
  cached so the next attempt starts warm. This value is always current: it
  is set from the SAME `rebuild()` that attaches footpaths to whatever index
  is actually being served, never left over from an earlier build.
- **A browse endpoint or `/meta`'s top-level fields still look stale
  immediately after a feed swap.** Check `/meta`'s `index.state`: while it
  reads `"building"`, the previous feed version is still being served
  everywhere (browse endpoints, `/meta`'s top-level fields, and `/plan`
  alike), correctly and on purpose, until the new build finishes and swaps
  in. If `index.state` already reads `"ready"` but a browse endpoint still
  disagrees with `/meta`'s top-level `version`, that is a regression; see
  [How it works](#how-it-works) and `src/routes/reload.test.ts`, which
  exists specifically to catch it.

## Rolling back or pointing at a different database

`data/gtfs.sqlite` is a symlink; both `gtfs` and this service treat
it as the sole source of truth for "which version is live". This service
resolves it fresh on every `TRANSIT_RELOAD_POLL_MS` poll (default 60 s), so
repointing it is enough: no restart required, and every endpoint (`/plan`,
every browse route, and `/meta`'s top-level fields alike) picks up the
change together:

```
cd <GTFS_DATA_DIR>   # default: <repo-root>/data
ls -la               # find the gtfs-<version>.sqlite you want live
ln -sfn gtfs-<version>.sqlite gtfs.sqlite
```

`ln -sfn` repoints the symlink atomically, matching how `gtfs`
itself publishes a new version, so there is never a moment where
`gtfs.sqlite` points at nothing. `POST /admin/reload` forces an immediate
re-check instead of waiting for the next poll.

## Layout

Longer design notes live in [`docs/`](docs): [how it works](docs/how-it-works.md),
[the transfer margin](docs/transfer-margin.md), [realtime](docs/realtime.md),
[known limitations](docs/known-limitations.md), and the
[planner notes](docs/planner-notes.md) behind `/plan`'s constants.

```
src/
  index.ts               bootstrap: build IndexManager, start server, start polling
  config.ts               env parsing, fail-loud
  server.ts               buildServer(): plugin + route registration
  geo.ts                  haversine, bbox helpers
  requestDrain.ts         tracks in-flight requests so a swap knows when it is safe to close the old handle
  db/
    connect.ts            symlink resolution, read-only open, feed_meta
    bundle.ts               AppBundle: db + translator + calendar + route lookups, built as one unit
    i18n.ts                translation resolution and fallback (Translator)
    stops.ts               stop search / nearby / detail queries
    lines.ts                route / trip / shape queries (see note below)
    departures.ts          departure-board queries
  transit/
    patterns.ts            trip -> pattern grouping, overtaking split
    index.ts                TimetableIndex: typed-array construction (buildIndex)
    buildWorker.ts          worker-thread entry point for buildIndex
    manager.ts              IndexManager: lifecycle, polling, single-flight ATOMIC rebuild of the index, the AppBundle, AND its footpaths
    calendar.ts             date -> active service set, service-day math
    footpaths.ts            stop<->stop walk matrix assembly + disk cache
    raptor.ts               forward RAPTOR (departAfter)
    raptorReverse.ts        backward RAPTOR (arriveBy)
    itinerary.ts            label -> leg reconstruction
  walking/
    valhalla.ts             matrix + route HTTP client, straight-line fallback
  geocode/
    types.ts                Geocoder interface + GeocodePlace, shared by both backends
    photon.ts               Photon HTTP client: search + reverse, soft-fails to []/null
    google.ts               Google Places/Geocoding client: sessions, field masks, daily ceiling
  routes/
    health.ts  meta.ts  admin.ts  agencies.ts  stops.ts  lines.ts  trips.ts
    departures.ts  plan.ts  geocode.ts
    plan/                      /plan's pieces: places, search, transferRisk, realtime, schema
    reload.test.ts             regression test: db/translator/calendar/routes stay in sync across a swap
    reload-footpaths.test.ts   regression test: footpaths survive a swap too, not just the RAPTOR schedule
```

`db/lines.ts` (not `db/routes.ts`) serves the `/routes` HTTP endpoints,
named for the GTFS *route* (transit line) resource it queries, while living
under `src/routes/` where a file called `routes.ts` would read as that
directory's own index rather than as GTFS routes.
