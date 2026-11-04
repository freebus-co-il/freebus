# How it works

## The RAPTOR index

On startup, and again on every detected feed swap, the service scans the
live SQLite database (all 9,817,029 `stop_times` rows, `35,266` stops,
`261,634` trips) into a set of typed arrays (`TimetableIndex`), grouping
trips that share a stop sequence into **patterns**. This measured build
(`npm run test:live`, against the real 666 MB database on 2026-08-22) found:

```
35,266 stops, 261,634 trips, 6,901 patterns, ~4.8 s
```

6,901 is **6,893 raw stop-sequence groups plus 8 split out for overtaking**:
two trips sharing a stop sequence but crossing in departure or arrival
order cannot share one RAPTOR pattern, or the engine's per-pattern binary
search breaks. This feed happens to have **zero dwell time**:
`MIN(departure_time - arrival_time)` and `MAX(...)` are both exactly 0
across all 9,817,029 rows, so arrival and departure are identical at every
stop, everywhere in this feed. That is worth knowing if you're reasoning
about the data directly: a schedule with real dwell would use both
columns meaningfully; this one never does.

The build (scan + pattern grouping) runs in a **worker thread**
(`src/transit/buildWorker.ts`), not the main thread. At a few seconds of
synchronous CPU work over ~85 MB of resulting typed arrays, running it
inline would add its full duration to the latency of every request in
flight, which happens on every feed swap, not just at boot. The previous
index keeps serving throughout a rebuild; the new one replaces it atomically
only once fully built, via `IndexManager`
([`src/transit/manager.ts`](../src/transit/manager.ts)), which polls the
`gtfs.sqlite` symlink every `TRANSIT_RELOAD_POLL_MS` and rebuilds only when
its target actually changed.

There is deliberately **no on-disk cache of the index itself**; rebuilding
from SQLite costs a few seconds, which does not justify a hand-rolled binary
format and the schema-drift risk of a stale cache file silently misread
after a field is added.

## A feed swap refreshes everything, atomically

Everything derived from the live database (not just the RAPTOR index, but
also the raw connection, the translation table, the calendar, and the
route-index lookups that `/agencies`, `/stops/*`, `/routes/*`, `/trips/:id`,
`/stops/:id/departures`, and `/meta`'s top-level fields all read) lives in
one `AppBundle` ([`src/db/bundle.ts`](../src/db/bundle.ts)), owned by
`IndexManager` alongside the `TimetableIndex`, which itself gets its
footpaths (re)attached as part of the same `rebuild()`, before anything
swaps (see [Footpaths](#footpaths) below). All of it is built from the
**same resolved path** on every `rebuild()` and swapped into place **in one
synchronous step**: if building the new index throws, neither the bundle
nor the footpath mode is ever touched, so a request can never see the
RAPTOR engine on one feed version and a browse endpoint on another, or a
`/meta` footpath mode that does not match what the served index actually
has attached. Everything a route handler reads
(`app.db`, `app.translator`, `app.calendar`, `app.routeBriefByIdx`,
`app.routeTypeByIdx`) is a Fastify getter reading `IndexManager`'s current
bundle, so every existing call site sees the swap without needing to touch
it. (An earlier version of this service captured `db`/`translator`/
`calendar`/the route lookups once, at boot, and never refreshed them; the
RAPTOR index correctly picked up a feed swap while every browse endpoint and
`/meta`'s top-level fields quietly kept serving whatever was live at
process start, forever. `src/routes/reload.test.ts` is the regression test
for this and must keep passing.)

The previous bundle's database handle is closed only once every HTTP
request that was in flight *at the moment of the swap* has finished,
tracked by `RequestDrain` ([`src/requestDrain.ts`](../src/requestDrain.ts)) via
`onRequest`/`onResponse` hooks, never by closing it synchronously alongside
the swap itself. This is deliberately asymmetric: the counter can only
resolve *late* (if some request's `onResponse` never fires: an abruptly
destroyed connection, say), never *early*, so the failure mode it cannot
fully rule out is "an extra read-only connection stays open a little longer
than necessary", never "a live request's database handle got closed out
from under it".

## Footpaths

The feed carries no `transfers.txt`, so every walking connection between
stops is derived. Candidate pairs are found with a straight-line prefilter
at `WALK_MAX_METERS` (complete, not heuristic: straight-line distance is a
lower bound on street distance, so nothing genuinely within range is ever
dropped), then scored either by a running Valhalla container
(`/sources_to_targets`, chunked in batches of `VALHALLA_BATCH_SIZE`) or, if
Valhalla is unreachable, by a straight-line estimate with a 1.35x detour
factor. Stops sharing a `parent_station` (235 stations, 1,083 child
platforms) get a flat `SAME_STATION_TRANSFER_SECONDS` cost instead and
bypass the walking prefilter entirely; an interchange's own platforms can
be farther apart than the walking radius, and the transfer cost isn't a
function of straight-line distance anyway.

**Footpaths are (re)attached on every successful `rebuild()`, not just the
first**, inside `IndexManager` itself, before the freshly built index is
ever swapped in to be served. `buildIndex` always starts a fresh
`TimetableIndex` with empty footpath arrays; skipping this step on a feed
swap (which an earlier version of this service did, since footpath
attachment used to be one-shot code in the process bootstrap rather than
part of the reload path) would silently leave the newly served index with
**zero** walking transfers (no stop-to-stop transfer, no same-station
interchange) from that swap until the next process restart, while
`/meta` kept reporting whatever footpath mode the ORIGINAL boot happened to
set. `src/routes/reload-footpaths.test.ts` is the regression test for this
and must keep passing.

**Only a real Valhalla result is ever cached** to
`TRANSIT_CACHE_DIR/footpaths-<stopSetHash>.bin`. A degraded straight-line run
is never written to disk, specifically so a one-off Valhalla outage at boot
cannot become a permanent straight-line configuration on every later
restart; the next attempt (boot, or the next reload) tries Valhalla again.
The cache key is a hash of the stop set (id, lat, lon) **plus the walk
options the arrays were built with** (`WALK_MAX_METERS`,
`TRANSFER_MIN_SECONDS`, `SAME_STATION_TRANSFER_SECONDS`, `WALK_SPEED_MPS`),
not the feed version. Keying on the stop set is what makes a normal feed
swap reattach footpaths in milliseconds (stops change rarely between
nightly imports), even though the RAPTOR index itself is always rebuilt from
scratch and the (expensive, several-hundred-thousand-pair) Valhalla
precompute only reruns when the stop set actually changes. Keying on the
options too is what makes **retuning one of them actually take effect**:
every number in the cached file is a function of them (`WALK_MAX_METERS`
decides which pairs exist at all, `TRANSFER_MIN_SECONDS` is added to every
edge, `SAME_STATION_TRANSFER_SECONDS` is the entire cost of a station-peer
edge, `WALK_SPEED_MPS` scales every straight-line estimate), so a key
without them let an operator change a value, restart, and silently be served
the arrays built with the old one, with `/meta` still reporting
`"footpaths": "valhalla"`, so nothing anywhere signalled that the change had
not landed. `VALHALLA_BATCH_SIZE` is deliberately **not** in the key: it only
chunks the matrix calls and cannot change a computed duration.

**Degraded-vs-stale, if footpath attachment fails outright** (not merely
"Valhalla is unreachable", which already degrades to a `"straight-line"`
*mode* rather than an exception; this is for something actually broken,
such as a corrupt cache file): the new index is still adopted, with
footpaths recomputed straight-line-only, rather than falling back to
keep serving the old, un-reattachable index. The live feed's calendar
window is only ~30 days wide; a service that refuses to adopt a fresh
index because footpath attachment glitched risks eventually serving a
window that no longer covers "today" at all (a guaranteed `422` for every
query), which is strictly worse than degraded walking transfers on an
otherwise-current schedule. This mirrors the existing "degrade, don't die"
policy already applied to a plain Valhalla outage, rather than inventing a
new policy for this one path. See `IndexManager.attachFootpathsTo`'s own
comment for the full reasoning, including why the straight-line-only
recomputation used in this fallback cannot itself realistically throw.

## Train track lines

The MOT feed publishes no shapes for Israel Railways, so without help every
train is a straight line between stations, across the sea on the coastal
line. `assets/rail-geometry.json` holds the real track between every pair of
stations a train calls at consecutively (102 pairs, ~70 KB), routed once over
OpenStreetMap's `railway=rail` network and committed. The API only reads it
(`src/rail/railGeometry.ts`): a leg or route joins the lines for its station
pairs, all or nothing, and falls back to its stations when any pair is missing,
logging that pair once, which is the cue to re-bake.

`npm run bake:rail` rebuilds it (`src/rail/bakeMain.ts`). It needs the GTFS
database for the station pairs and fetches the network from Overpass (or
reuses a saved response with `--overpass-file`). Routing on the raw network
drew 30–236 km detours until three things were handled, each measured:

- **Junction tracks count.** `service=crossover/siding/spur/yard` ways are what
  connect the lines; without them the network falls apart into islands.
- **A station can stand on any nearby track.** Each station snaps to every
  node within 150 m (or 40 m past its nearest), not the single nearest one,
  or a multi-track section strands the other direction.
- **Trains do not reverse at switches.** The routing is edge-based and forbids
  turns over 45°, ignoring segments under 8 m, where OSM's switch stubs make
  bearings noise.

On 2026-09-15 data every pair routed, with a median length 1.03× the straight
line and a worst of 2.28× (the real Beer Sheva curve). The bake refuses to
write when a pair is unroutable, a line exceeds 3× (a wrong corridor), or the
Overpass instance's data is over 30 days old (a mirror served June data that
baked a 9.2× detour); `--force` overrides the first two.

OSM data is ODbL: the file carries the attribution string, and a client
showing these lines must credit "© OpenStreetMap contributors".

## Service days and the midnight rule

There is no `calendar_dates.txt` in this feed, so `calendar.txt` alone
decides which `service_id`s run on a given date; there are no exceptions
to layer on top. GTFS times are seconds after *noon minus 12 hours* on the
service date, not after literal midnight, which matters on the two days a
year Israel's DST transition falls: noon-anchored arithmetic doesn't shift
by an hour there where midnight-anchored arithmetic would. A query's
instant is checked against **both** the current service day and the
previous one, because a trip departing "yesterday at 25:30" is still
running at 01:30 today; every query considers both so no call site can
forget to.

The same transition is why a departure board is ordered on the **epoch**,
never on the rendered ISO string. Merging two service days across the
autumn fall-back merges two different UTC offsets, and the local-time digits
of one are then not comparable with those of the other at all:
`2026-10-25T01:30:00+03:00` is genuinely 40 minutes *earlier* than
`2026-10-25T01:10:00+02:00` but sorts *later* as a string. ISO is rendered
only after the sort and the `limit`, so the wire format is a presentation
detail that no ordering depends on.
