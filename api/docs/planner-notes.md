# Planner notes

The measurements behind constants and design choices in `src/routes/plan/`.
The code comments state each rule; this file keeps the evidence that set it,
so a change to one of these values starts from the numbers rather than from
memory. All figures were measured against the real feed (`data/gtfs.sqlite`)
unless stated otherwise.

## `ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS` (12 h)

The bound applies to the longest single wait between two rides in a
reverse-built itinerary. It does not apply to `durationSeconds`.

**Why not `durationSeconds`.** On `arriveBy`, `durationSeconds` is roughly
"deadline minus door departure": it describes the question, not the journey.
A controlled probe (same origin, destination and single bus, only the deadline
moved from 07:00 to 20:00) showed it climbing from about 2 h to about 15 h
for the same 1 h ride. A bound on it, tried against 300+ OD pairs with
generous deadlines, dropped an itinerary on 15.9% of pairs and returned
nothing at all on 2.8%. Of 53 dropped itineraries only 16 had any wait over
8 h. No threshold on that field separates the two populations. (The cause: a
reverse chain ending in a footpath into the destination reports the deadline,
not the real arrival, as `arrivalTime`, a known defect that predates this
bound.)

**Why 12 h.** The wait is computed from each transit leg's own times, less
the reported (buffer-stripped) walk, so the ~60 s boarding buffer counts as
wait; that is negligible here. Across 629 measured itineraries, the largest
wait in a genuine, undominated itinerary was 10.29 h (Mitzpe Ramon to Netanya,
one transfer, with no strictly-later alternative with the same or fewer
transfers). The smallest genuine artefact was 12.81 h. None fell between 11 h
and 12.8 h, so 12 h is the whole-hour value inside the gap. A 10 h bound
would reject the Mitzpe Ramon journey.

**Large waits are usually real.** Re-querying `departAfter` from the
departure + 60 s of 50 itineraries with waits over an hour found 0 of 50 with
a strictly-later, same-or-fewer-transfer alternative. The artefact this bound
catches shows up in about 1 in 300 random OD pairs. A wait that looks like
travel in the wrong direction is usually a misreading of the route
`longName`, which names both pattern endpoints (`X<->Y`) whatever direction a
given trip runs.

**Why it is gated on the request's factor.** The bound is active only when
`TRANSFER_HEADWAY_FACTOR` is non-zero, so `0` restores the old behaviour
exactly. It reads the request's configured factor, not the current pass's:
the flat second search runs at factor 0, and reading the pass's own factor
once switched the bound off for exactly that pass. That let through the
~13h50m-wait `TFEED -> T4X` fixture chain the configured pass had rejected.

## `ARRIVE_BY_MAX_LOOKBACK_SECONDS` (24 h)

`buildDayContexts` includes the query day and the day before, so a trip
running "yesterday at 25:30" can still be found. Nothing about the reverse
search says which day must satisfy the deadline: with no usable service
today, yesterday's ordinary 08:00 bus satisfies "arrive by 08:05 today". The
two-day context can legitimately produce at most a ~24 h-earlier result, so
anything earlier is the unwanted case.

The probe does not apply it: a probe candidate must depart at or after the
query instant, which is strictly stronger.

## Merging the flat-buffer search (`searchBoth`)

At the last service of the day, each RAPTOR pass already lets one connection
yield to the flat buffer rather than lose the journey. That cannot fix a
chain effect: the margin moves the rider onto a later trip at one
interchange, and the last service downstream has gone by the time they
arrive. Measured: 1 of 241 random late-evening queries.

Running the flat search only when the margin-respecting one came back empty
was tried first. On 513 routable queries it left 138 (26.9%) with fewer
itineraries than the flat rule finds, and the dropped ones mattered. Against
a reference planner on 11 real trips departing 08:00, the margin alone lost
42 minutes of arrival time in total and was worse on 6 of 11, including
single-query losses of 16 min (Dizengoff Center to Weizmann Institute),
21 min (Kiryat Shmona to Technion) and 9 min (Ashkelon to Kfar Saba).
Merging both candidate sets made it 28 minutes better in total, and worse on
only 2 trips, by one minute each.

The reason: refusing a 96-second connection onto a bus every 15 minutes does
not cost the rider 15 minutes. It moves them onto a structurally different
journey that can cost 45. Insurance must not cost more than the loss it
covers, and as a hard gate this margin could.

Nothing is lost by merging: the margin-respecting set is still there,
ranking dedupes by `journeyKey`, and `annotateTransferRisk` flags every
connection the configured margin wanted more slack for. The cost is a second
search on every query while the factor is non-zero.

## The realtime yield

The same principle as the last-service fallback: live delays may refuse a
connection the timetable offers, and when that leaves nothing at all, the
planner answers on the timetable and flags the connection through
`transferAtRisk`. Only for total emptiness: a query with some live-feasible
journey keeps only those. The extra searches run only on queries that would
otherwise return nothing.

## `nearestStops`

A bounded top-n insertion scan: 0.59 ms against 9.68 ms for sort-and-slice
over the feed's 35,266 stops. With both endpoints falling back, the sort would
add ~19 ms to a request that already holds the event loop for 50 to 200 ms on
the 2-vCPU production box.

## Per-request costs

- `headwayTableFor`: 22.7 ms on a cache miss, 0.004 ms on a hit
  (`buildHeadwayTable` itself: 16.5 ms cold, 10.9 to 11.7 ms warm per service
  day).
- `shiftsFor`: re-sorting the touched patterns costs about 124 ms at rush hour,
  which is why it is built once per realtime snapshot and shared, not built
  per request.

## Realtime departure derivation

SIRI predicts one arrival per stop call. `predictedDeparture` applies the
board-stop arrival delay to the scheduled departure. Every one of the feed's
9.8M `stop_times` rows had `arrival_time === departure_time` (checked
2026-08-23), so today the result equals the raw prediction. Deriving it this
way keeps it correct for a feed with real dwell times.

## The forward/reverse margin mismatch (`requiredMarginFor`)

A confirmed case for why `reverseSourced` matters: an `arriveBy` itinerary
reported `transferAtRisk: false` for a connection the reverse pass required
600 s for, with only 120 s of real slack left after a ten-minute predicted
delay. It had been compared against the smaller forward-pass margin.
