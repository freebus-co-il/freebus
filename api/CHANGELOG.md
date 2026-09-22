# Changelog

Notable changes to `api`. Versions follow semver's 0.x convention:
while the major version is 0, a **minor** bump is what carries a breaking
change.

## Unreleased

### Breaking

- **A departure board row and a line's run are identified by `runId`, not
  `tripId`.** An unscheduled bus (below) shares its template trip's `tripId`,
  so a client keying rows by `tripId` would collide. Every row and run now
  carries `runId` (equal to `tripId` for the timetable) and `unscheduled`;
  runs also carry `offsetSeconds`. `freebus` keys its station board, nearby
  pills and line-page run strip by `runId`, labels unscheduled buses, and
  shows a picked unscheduled run's own (shifted) times on the line page.

- **With no MOT key, realtime now reads the open-bus raw snapshot instead of
  Stride, and `source` has a third value, `"open-bus-vm"`.** It appears on
  every `realtime` block, on `/meta`, and on `/vehicles`. A client that
  switches exhaustively on `source` must handle it; `freebus`'s own types
  gained it alongside this. Stride remains available with
  `REALTIME_KEYLESS_SOURCE=stride`.

  Why: it is the same MOT data, but Stride's ETL loads each snapshot 13–23
  minutes late on a weekday (2026-09-10's 05:00Z snapshot finished loading at
  05:16:27), while the Public Knowledge Workshop's raw per-minute file is live
  about 30 seconds after its minute. Replayed against that weekday's morning
  peak with the archived raw feed as ground truth, a bus had a prediction for
  only 2–32% of the five minutes before it arrived on Stride, and 97–98% on the
  raw file.

- **`/plan` orders its answers by rider effort, not by arrival time, and
  `transfers` is no longer the primary sort key.** A one-transfer
  twelve-minute journey now outranks a zero-transfer twenty-minute one. Each
  itinerary is scored `durationSeconds + walkSeconds × (PLAN_WALK_WEIGHT − 1)
  + PLAN_TRANSFER_PENALTY_SECONDS × transfers` and the list is sorted by that
  ascending, departure time breaking ties. Because `durationSeconds` is
  measured from the itinerary's own re-anchored departure, waiting at the
  origin costs nothing — which is the whole mechanism: a later, easier
  journey can now beat an earlier, harder one.

  The defect this fixes, measured on the live feed: a 20-minute answer whose
  first 17 minutes were a 1.6 km walk, returned as the best journey while a
  12-minute bus leaving 23 minutes later was never even a candidate. Walking
  and riding minutes were interchangeable to the old ordering, and an
  earliest-arrival forward search charges waiting at the origin at full
  price, so standing still for 23 minutes always lost to walking.

  A client that relied on "fewest transfers first, ties broken by duration"
  needs updating. `freebus`'s own sort toggle changed from
  `'transfers' | 'duration'` to `'best' | 'duration'` alongside this.

- **`/plan` drops two shapes of itinerary outright, so some queries that
  returned a journey now return `200 { itineraries: [] }`.**

  - **No transit leg at all.** Any stop lying inside both the origin and the
    destination walk radius was reachable with zero boardings, so the planner
    could return access-walk + footpath + egress-walk and report it as
    `transfers: 0`. A point pair with no transit between them is now an empty
    list rather than a walking suggestion — this is a transit API, and a
    walking route is a different product the client can offer itself. **No
    off switch**, deliberately: this was a defect, and defects do not get a
    way to stay on. One documented consequence: the nearest-stop fallback's
    multi-kilometre walk leg no longer guarantees the itinerary survives (the
    README's own claim that it did has been corrected).
  - **Walking above `PLAN_MAX_WALK_SHARE` (default 0.7) of the itinerary's
    own duration.** A backstop against the pathological tail only — the cost
    function above is what demotes walk-heavy journeys in the ordinary case.
    Set `PLAN_MAX_WALK_SHARE=1.0` to disable it.

  Neither filter triggers the never-empty query-level retry: that guarantee
  is about the *search*, and the flat margin would find the same journey for
  these filters to drop again.

- **`/plan/onboard` is ordered by the same cost function**, which it had no
  final sort of at all before (`paretoRounds` orders by round, so a slower
  journey could print above a faster one). Both filters are deliberately
  **off** there: a rider already aboard has no access leg, so "get off here
  and walk the rest" is a legitimate zero-transit-leg answer rather than the
  leak the filter exists to catch.

### Added

- **Trains are drawn along their real track.** The MOT feed has no shapes for
  any rail trip, so every train leg, rail route shape and rail trip detail was
  a straight line between stations. They now follow track lines routed over
  OpenStreetMap and baked into `assets/rail-geometry.json` (`npm run
  bake:rail`), with `geometryFallback: false`. A station pair missing from the
  bake still falls back through its stations, flagged, and is logged once.
  Clients need no change; showing these lines owes an OSM credit.

- **`GET /routes/:routeId/vehicles`** — every bus currently on a route, for a
  line's own map. Same response shape, the same freshness gate, and the same
  "200 with an empty `vehicles` list" contract as `/vehicles`; never a `404`,
  because answering one would mean a database check on every poll of a map
  refreshed every 20 seconds. A scan of the in-memory snapshot for the
  route's trips, not a lookup — the caller has no trip ids for buses that
  have not started yet.

- **Every `/stops/:stopId/departures` row (and `/routes/:routeId/trips`
  run) now carries `lineCode` and `lineDirection`.** The same identity and
  direction key `GET /lines/:lineCode` resolves and its direction toggle is
  keyed on, so a board or run-list row can open its line directly, with no
  extra lookup to translate a `route_id` into a line.

- **`GET /routes/:routeId/trips?stopId=&around=`** — the run a rider tapped
  on a station board, timed at that stop, with the run just ahead of it and
  up to `limit` runs behind it. `nextRuns`'s own default mode times runs from
  the route's first stop and only looking forward, which is usually already
  in the past for the run a rider actually tapped; this mode answers "what
  else is on this line around what I'm waiting for" from the rider's own
  stop instead. `stopId` and `around` are given together or not at all — a
  `400` otherwise. An unknown trip id, or one that does not call at `stopId`
  inside the probe window, answers `{ runs: [] }` rather than a guess.

- **Live buses whose start time is not a timetable slot now appear.** At the
  2026-09-10 weekday peak, 3.8% of fresh buses matched no slot exactly and
  were dropped. A second matching pass takes the nearest slot within 15
  minutes on the same route and direction: an empty slot takes the bus as its
  own run (a retimed departure — its offset reads as delay); a slot that
  already has a bus makes it an **unscheduled run**, timed as that trip
  shifted by the start-time difference. Unscheduled runs get their own rows on
  `/stops/:stopId/departures` and come first on `/routes/:routeId/trips`'s
  default run list while on the road — its `?stopId=&around=` mode (the runs
  around a tapped trip) does not include them. `/plan` and `/vehicles` still
  use the timetable only. `/meta`'s realtime block adds `attached` and
  `unscheduled`; `nearMissCount` now counts buses still unmatched within an
  hour of a slot.

- **`REALTIME_KEYLESS_SOURCE`** (`open-bus`, the default, `stride`, or `off`)
  chooses the feed used when no MOT key is configured, and **`OPEN_BUS_BASE_URL`,
  `OPEN_BUS_POLL_SECONDS`** (default 20, floor 10) and
  **`OPEN_BUS_MAX_VEHICLE_AGE_SECONDS`** (default 1800) configure the open-bus
  poller. An unrecognised value fails at boot. The older `STRIDE_ENABLED=false`
  still means "no keyless realtime" when `REALTIME_KEYLESS_SOURCE` is unset, so a
  deployment that set it does not light up the new feed unasked.

  The poller reads the 84-byte `daemon_status.json` every poll and downloads a
  snapshot (~270 KB brotli at peak) only when it names a minute not already
  stored, so a stalled requester goes stale on `/meta` rather than being
  re-served as fresh.

- **`GET /vehicles?trips=T1,T2` — where the buses on a journey's legs are
  right now, for drawing on a map.** Answers from the SIRI snapshot the
  poller already holds in memory: no upstream call, no database query, and
  the same cost whether one client is polling it or a thousand are. Returns
  `{ source, vehicles: [{ tripId, lat, lon, recordedAt, vehicleRef }] }`,
  listing only the trips that have a fresh position — it is not a per-trip
  result array, so callers key by `tripId`. At most 12 trips per request
  (`/plan` caps a journey at 7 legs).

  **On a keyless feed, a bus is drawn only while its own report is at most
  five minutes old** — the same line the store draws for anchoring an ETA on a
  report. The raw open-bus feed's reports are normally about a minute old, so
  its buses are drawn; Stride's weekday reports lag 13–23 minutes and are not,
  and neither are any operator's reports that are running late (all of Egged's
  were ~21 minutes behind on 2026-09-13). A report with no `RecordedAtTime` is
  not drawn on a keyless feed. With a MOT key, every position is drawn as
  before. A rider reads the dot as where the bus *is*, so an old one is worse
  than none. `source` says which feed answered. The app labels each dot with
  its age ("now", "2 min") and dims one whose report is over two minutes old.

- **`/plan` runs one extra reverse RAPTOR pass on `departAfter` to find
  later-departing, lower-effort journeys.** A forward earliest-arrival search
  cannot see a journey that departs later *and* arrives later, however much
  less effort it is — it is dominated on arrival and never becomes a
  candidate, so no amount of reordering can surface it. The reverse pass at a
  relaxed deadline (the earliest arrival plus
  `PLAN_DEPARTURE_WINDOW_SECONDS`) yields the latest-departing journey per
  transfer count, which is exactly the missing half. Results are merged with
  the forward pass's and deduped on the `(tripId, boarding stopSequence,
  alighting stopSequence)` sequence, keeping the later departure of two
  reconstructions of the same ride.

  One fixed extra search, **independent of window width** — widening the
  window moves the deadline, not the work. A textbook range search (one
  forward pass per departure in the window) is what this deliberately is not.
  Reverse-built chains from this probe are subject to the same 12 h
  interior-wait bound the `arriveBy` branch applies.

- **Five configuration keys**, all documented in the README's Configuration
  table: `PLAN_WALK_WEIGHT` (`2.0`, range 1.0–5.0),
  `PLAN_TRANSFER_PENALTY_SECONDS` (`300`, 0–3600),
  `PLAN_DEPARTURE_WINDOW_SECONDS` (`1800`, 0–21600), `PLAN_MAX_WALK_SHARE`
  (`0.7`, 0.0–1.0) and `PLAN_REVERSE_PROBES` (`1`, 1–3).

  `PLAN_WALK_WEIGHT=1` with `PLAN_TRANSFER_PENALTY_SECONDS=0` restores
  duration ordering exactly. Be precise about what that is: a
  **cost-function** off switch, not a **feature** off switch. The extra
  reverse pass still runs and both filters still apply, so it is not
  byte-identical to the pre-feature planner the way
  `TRANSFER_HEADWAY_FACTOR=0` genuinely is.

  `PLAN_DEPARTURE_WINDOW_SECONDS` bounds how far the free origin wait may
  reach: a `departAfter` journey departing more than that past the **earliest
  feasible departure** is still listed but never promoted above one inside
  the window. Anchored on the earliest *feasible* departure rather than on
  the requested time, so asking at 11:16 when nothing runs until 14:00 makes
  the window 14:00–14:30 and returns that service instead of an empty list.
  It is not applied on `arriveBy` — with the arrival pinned by the query, a
  later departure is unambiguously better for the rider and strictly cheaper
  — nor to the reverse probe's own candidates, whose arrival is already
  bounded by the deadline they were generated at.

- **`GET /plan/onboard`** — the other half of active-journey mode: re-plans
  from the vehicle the rider is currently aboard. `onTrip` +
  `onTripFromStop` name the trip and the stop they last passed; every stop
  that trip still reaches becomes a candidate alighting point, seeded into
  the existing RAPTOR forward search at the vehicle's own delay-adjusted
  arrival there. No new search and no new algorithm — staying aboard longer
  is a later seed, getting off early an earlier one. Each itinerary carries
  `alightAt` (stop and arrival) so a client can tell "get off at the next
  stop" from "stay aboard four more stops", and the response says which
  timing it used (`delaySource`: `realtime` | `client` | `schedule`), the
  client's own `delaySeconds` being what makes this useful before a SIRI key
  exists. Unlike `/plan`, the FIRST boarding is charged the full transfer
  margin: the rider has an incoming vehicle that can be late, and it is the
  one they are sitting on — and, because `/plan`'s own risk checks walk
  transit-leg-to-transit-leg pairs and the rider's vehicle is not a leg,
  this endpoint prices that first boarding itself so the
  [per-connection fallback](README.md#the-headway-scaled-transfer-margin)
  or retry hands back a sub-margin connection **flagged** rather than
  silently, or with an affirmative `transferAtRisk: false` on top.
  `arriveBy` is a `400`. Stateless; no
  `stop_ref`/`trip_ref` in the response. See the README's
  [Re-planning from aboard](README.md#re-planning-from-aboard) section.

- **`GET /journey/check`** — for a rider already partway through a journey:
  given the remaining legs (`leg=tripId,fromStopId,toStopId`, repeated, in
  journey order), reports each leg's current schedule/realtime times and
  whether each connection between them still holds, without re-planning. A
  broken connection is reported, not routed around. `holds` is three-valued
  (`true`/`false`/`null` — never collapsed into `false` for lack of data)
  and reuses `/plan`'s own headway-scaled transfer margin rather than
  reimplementing it, always at its more conservative form since this
  endpoint cannot know which of `/plan`'s two RAPTOR passes built the
  original itinerary. Stateless; no `stop_ref`/`trip_ref` in the response.
  See the README's [Active journey check](README.md#active-journey-check)
  section.

- **`GET /segments`** — every trip serving an exact stop pair `from` → `to`,
  in that order, ordered by departure: the "what else gets me from here to
  there" list a client shows when a `/plan` transit leg is expanded. A
  lookup over the in-memory RAPTOR index, not a re-plan of the segment — no
  headway margin, no reachability search. `results` (default 10, cap 50) is
  not a time window: each candidate pattern contributes up to `results`
  trips on its own regardless of how far away they are, so a low-frequency
  pair (an intercity rail segment queried mid-morning, say) still gets its
  next departures instead of an empty list. Same `404`/`400`/`503` and
  past-midnight/previous-service-day conventions as `/plan` and
  `/stops/:stopId/departures`. See the README's Browse table.

### Fixed

- **A bus still on its way no longer disappears from the departures board, or
  from `/plan`'s predictions, once its estimate has aged.** A position-derived
  estimate assumed the bus kept the timetable's pace from its last report, so a
  bus held at a light slid into the past and was dropped as already gone. Seen
  live on 2026-09-13: a line 5 bus vanished from Dizengoff Center's board at
  20:36:19, 450 m away, and arrived at 20:38:55 — while another planner showed 20:38:45.
  When the report behind an estimate was at most five minutes old when fetched,
  the estimate is now read as the stored ETA plus half the time since the bus
  was last placed, and never at or before now while nothing places it past the
  stop. Measured at 0–10 minutes out, this roughly halved the error against
  observed arrivals, on the weekday replay and against other planners' estimates alike. An older
  report keeps the plain estimate: on Stride's 13–23 minute-old positions the
  same rule made the error worse (118 s → 334 s), because that time is lag, not
  a bus standing still — and on 2026-09-13 every Egged report on the raw feed
  ran ~21 minutes late too. The rule is the report's age, not the feed.
- **A bus waiting at its terminal before its start time is no longer reported
  as running early.** Seen live as lines 238 and 2 showing five minutes early
  while still parked. A bus at its origin is now on time until its start time,
  then late; one that has actually left early is still early.

- **README: the `/journey/check` service-day rule was documented backwards.**
  It described the staleness bound as measured from `at`'s own calendar day
  (midnight), which is the version that was reproduced WRONG and replaced
  before that endpoint merged — the shipped rule measures six hours back from
  `at` itself, which is what keeps a leg boarded 23:30 and checked at
  00:00:01 eligible. Code unchanged; only the prose was stale.

## 0.2.0 — 2026-08-23

### Breaking

- **`/plan`: `departureTime` now means "the latest feasible door departure"
  under `departAfter`, not the query instant.** Previously a 07:00 query
  answered by an 08:00 train reported `departureTime: 07:00` with the hour of
  platform waiting folded into `durationSeconds`. It now reports the time the
  traveller should actually leave. `arriveBy` already behaved this way and is
  unchanged.

  Two observable consequences for existing clients:

  - `departureTime` moves **later** and `durationSeconds` **shrinks** for the
    same journey. `arrivalTime` is unchanged — reoptimisation only ever moves
    the departure.
  - A client deriving wait time as `firstBoarding − departureTime` now gets
    **~0** instead of the real platform wait. That difference no longer
    exists to derive; if you need "time until departure", compute it against
    the current clock, not against `departureTime`.

  The refinement pass that finds the *latest* such departure runs for the
  first `PLAN_REOPTIMISE_MAX_ITINERARIES` itineraries (default 3) for latency
  reasons; every itinerary is re-anchored on its own first boarding
  regardless, so none ever reports the query instant.

### Added

- **`/plan`: transit legs carry `geometry`** — a precision-6 encoded polyline
  sliced from the operator's own shape between the leg's board and alight
  stops — **and `geometryFallback: boolean`**. Both are additive; existing
  fields are unchanged.

  `geometryFallback: true` means the line is a straight line through the
  leg's two stops rather than the operator's shape. **Every rail leg is a
  fallback**: all 1,085 `route_type` 2 trips in the feed (100% of them) carry
  no `shape_id`. Bus and other shaped legs report `false` and real geometry.

  `geometryFallback` is a transit-leg field only — on a **walk** leg it is
  absent (`undefined`), and walk legs still always report `geometry: null`.

- `PLAN_REOPTIMISE_MAX_ITINERARIES` (default 3, range 0–10) bounds the
  departure-reoptimisation pass.

### Fixed

- A leg sliced from a shape whose `shape_dist_traveled` scale disagrees with
  the shape itself no longer ships the wrong line flagged as real geometry.
  0.92% of shaped trips in this feed have such a scale; one produced an
  8-metre polyline ending 3,675 m from the alight stop with
  `geometryFallback: false`. The slice is now validated against the leg's own
  stops and degraded — to a nearest-vertex projection, then to a flagged
  straight line — when it does not match.

## 0.1.0

Initial service: browse endpoints over the GTFS database, a RAPTOR journey
planner at `/plan`, and the admin reload path.
