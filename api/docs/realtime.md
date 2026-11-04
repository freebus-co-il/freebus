# Realtime (SIRI-SM)

Live vehicle predictions from the Ministry of Transport's SIRI-SM feed,
annotated onto `/plan`'s transit legs and `/stops/:stopId/departures`'
entries. **With `MOT_SIRI_KEY` and `MOT_SIRI_BASE_URL` both configured**, the
poller described below reads MOT directly and every prediction is the
operator's own ETA (`source: "siri-sm"`); see
[Configuration](../README.md#configuration) above for those settings and the
boot-behaviour caveat. Setting only one of the two is a misconfiguration: it
warns and realtime stays off.

**With no MOT key**, realtime reads the same national data keylessly, as
chosen by `REALTIME_KEYLESS_SOURCE`:

| Value | Feed | Positions are | `source` |
| --- | --- | --- | --- |
| `open-bus` (default) | the Public Knowledge Workshop's raw per-minute snapshot, `OPEN_BUS_BASE_URL/YYYY/MM/DD/HH/MM.br` | about a minute old | `"open-bus-vm"` |
| `stride` | their Stride database | 13–23 minutes old on a weekday (ETL lag) | `"stride-vm"` |
| `off` | nothing; `app.realtime` is `null` and no poller runs | n/a | `null` |

Neither keyless feed carries ETAs, only where each bus is. A prediction is
derived from the bus's distance along its trip against the timetable, and
propagated to the stops ahead of it. When the report was at most five minutes
old on arrival it is then read against the clock: the stored ETA plus half the
time since the bus was last placed, and never at or before now while nothing
places the bus past the stop, so a bus held at a light stays on the board
instead of sliding into the past. An older report (all of Stride's on a
weekday, and any operator whose reports are lagging) keeps the plain estimate. A bus
waiting at its origin before its start time is on time, never early. See
[`src/realtime/openBus.ts`](../src/realtime/openBus.ts) and
[`src/realtime/store.ts`](../src/realtime/store.ts) for the measurements behind
each rule.

`OPEN_BUS_POLL_SECONDS` (default 20, floor 10) is how often the 84-byte status
file is read; a snapshot is downloaded only when it names a new minute.
`OPEN_BUS_MAX_VEHICLE_AGE_SECONDS` (default 1800) drops a bus that has not
reported for that long. `STRIDE_ENABLED=false`, which predates the open-bus
feed, still means `off` when `REALTIME_KEYLESS_SOURCE` is unset.

Server-side, a poller holds two national snapshot streams in memory, the
`AllActiveTripsFilter&calls` stream (vehicles already under way, on
`REALTIME_POLL_SECONDS`) and `AllPlannedTripsFilter` (trips departing within
4h that have not yet started, on `REALTIME_PLANNED_POLL_SECONDS`), so
annotating a response is an in-memory lookup, never a per-request call to
MOT. A snapshot older than `REALTIME_MAX_AGE_SECONDS` is treated as absent
everywhere it is read.

**A transit leg's `realtime` field** (`null` when this trip has no fresh,
resolved data: disabled, stale, and "SIRI never matched this trip" all
collapse to the same `null`, deliberately indistinguishable from a response
consumer's point of view):

```json
"realtime": {
  "predictedDeparture": "2026-08-24T08:05:12+03:00",
  "predictedArrival": "2026-08-24T08:53:04+03:00",
  "delaySeconds": 244,
  "vehicleRef": "12345",
  "confidence": "reliable",
  "recordedAt": "2026-08-24T08:04:50+03:00"
}
```

`delaySeconds` is predicted minus scheduled at the leg's own alight stop
(negative means running early); `predictedDeparture` is derived from the
board stop's predicted arrival, not a separate SIRI field (see
`realtimeForLeg` in [`src/routes/plan/realtime.ts`](../src/routes/plan/realtime.ts) for why). A
departures-board entry carries the same six fields under its own
`realtime`, except `predictedArrival` is always `null` there: a board entry
is a single stop visit, not a leg with a separate arrival to report.

**Unscheduled runs.** A live bus whose scheduled start is not a timetable slot
is matched to the nearest slot on its route and direction within 15 minutes.
If that slot has no bus of its own, the bus is that run. Otherwise it is an
unscheduled run: the board lists it as its own row with `unscheduled: true`,
the template trip's `tripId`, and a `departureTime` shifted by its start
offset. `lineCode` and `lineDirection` come from that template trip, like
every other row. Its `runId` is `tripId@vehicleRef`, or `tripId@offsetSeconds`
when the feed gave no vehicle ref; if that id would still repeat within one
response (two runs on the same template with the same vehicle ref, or none and
the same offset), `#2`, `#3`… is appended so every row's `runId` is unique.
`/routes/:routeId/trips` lists it first, with `offsetSeconds`, while it is on
the road; its `?stopId=&around=` mode (the runs around a tapped trip) does not
include unscheduled runs, only the default run list does. Every board row and
run carries `runId`; key by it, not by `tripId`.

**An itinerary's `transferAtRisk`** is `true` when some transfer has less
slack than the planner's own required margin. **Two independent routes lead
to `true`, and a client should treat them the same way; the field does not
currently distinguish them:**

1. **From the schedule alone.** The connection is tighter than the
   headway-scaled margin wanted, because the planner deliberately yielded to
   the flat buffer rather than delete the journey (see [the last-service
   rule](transfer-margin.md#the-headway-scaled-transfer-margin) above, and the query-level
   retry). This is computed on **every** request and **does not need
   realtime**: `true` with realtime disabled means exactly this: the printed
   schedule itself leaves less room than the rule asks for.
2. **From realtime.** A predicted arrival, plus the connecting walk and the
   required margin, lands after the next leg's scheduled departure; live
   data says the connection RAPTOR built no longer holds.

`false` means every transfer clears the margin on the schedule **and** live
data confirms it, including the trivial case of no transfer at all.
**`null`**, not `false`, when at least one transfer's live status cannot be
determined and none is at risk on either route: a client must be able to tell
a genuinely safe connection from an unmeasured one. With realtime disabled,
an itinerary therefore reports `true` if the schedule alone condemns a
transfer and `null` otherwise; it never reports `false`.

Note that `true` is common in the late evening (measured at 45% of
itineraries overall and 52% of evening queries) because that is when last
services dominate and the schedule-alone route fires. A client showing this
as a hard warning should expect to show it often; splitting the two routes
into distinguishable values is a recorded follow-up, not shipped.

**`GET /meta`'s `realtime` block** reports `health`
(`disabled`/`ok`/`stale`/`failing`), `ageSeconds`, and the resolution
counts (`journeys`, `resolved`, `unresolved`, `resolvedWithNoCalls`,
`nearMissCount`); `disabled` with no key configured, always. Never the key
or the base URL. `failing` means the poller's most recent tick(s) errored,
even if the store is still serving a snapshot within
`REALTIME_MAX_AGE_SECONDS`; `stale` means the store has nothing fresh
enough, whether because nothing has been polled yet or the last good
snapshot aged out. `resolvedWithNoCalls` counts journeys that matched a
trip but resolved zero stop predictions; a wrong stop-code join can make
this equal `resolved` while every leg's `realtime` is still `null`, which
`resolved`/`unresolved` alone would not show. `nearMissCount` is diagnostic
only: unresolved journeys that matched route/direction/day within one hour
(3,600 seconds) of a trip's scheduled departure without matching it exactly
-- widened from the original 300 seconds now that pass 2 itself matches
everything within 15 minutes, so the old tolerance would always read zero;
it never affects resolution. `attached` counts buses matched to an empty slot
within 15 minutes rather than exactly, and `unscheduled` counts buses shown
as unscheduled runs. A `streams` block additionally reports
`active-calls`'/`planned`'s own last-success timestamp, failure count and
last (redacted) error, separately; the combined fields above cannot tell
"one stream is down" from "both are".

**`GET /vehicles?trips=T1,T2`**: where the vehicles running those trips
are right now, for drawing on a map. Answers from the same in-memory
snapshot everything else here reads: no upstream call, no database query,
the same cost whether one client polls it or a thousand do. At most 12 trips
per request (`/plan` caps a journey at 7 legs); an empty or missing `trips`
is a `400`.

```json
{
  "source": "siri-sm",
  "vehicles": [
    { "tripId": "T1", "lat": 32.0554, "lon": 34.78,
      "recordedAt": "2026-08-24T07:58:00+03:00", "vehicleRef": "veh-1" }
  ]
}
```

With a MOT key every resolved position is drawn. On a keyless feed
(`open-bus-vm`, `stride-vm`) a vehicle is listed only while its own
`recordedAt` is at most five minutes old at request time, and never when the
feed gave no report time: a dot claims to be where the bus is, and the raw
feed's reports are normally about a minute old while Stride's lag 13–23
minutes on a weekday.

`vehicles` lists only the trips that HAVE a fresh position; it is not a
per-trip result array, so key by `tripId`, not by position. An unknown trip
id, a trip SIRI never matched, a journey whose feed omitted
`VehicleLocation`, and a snapshot past `REALTIME_MAX_AGE_SECONDS` all
produce an omitted entry rather than an error. `source` reports which feed
answered (or `null`), so a client can tell "this deployment has no live
positions at all" from "this particular bus is not reporting".

**This endpoint deliberately answers `vehicles: []` on the Stride SIRI-VM
fallback**, even though those rows do carry coordinates. Stride's ETL lag
scales with load and runs at 14–24 minutes through the whole service peak
(measured over 399 consecutive snapshots; see
`STRIDE_MAX_VEHICLE_AGE_SECONDS` in [Configuration](../README.md#configuration)). That
is tolerable for deriving one delay against a schedule, since a bus 20
minutes into a 40-minute run is still late by about the same amount. It is
not tolerable as a position: a rider watching the dot reads it as where the
bus *is*, and will let one go by or run for one already gone. The gate is
server-side, so the day `MOT_SIRI_KEY` is configured this starts answering
and a client's map fills in with no release of its own.

**Rail carries no position.** Per the ICD, Israel Railways sends predictions
but no `VehicleLocation` at all, so a rail leg's `realtime` block should
populate while `/vehicles` stays empty for that trip. Like everything else
in this section, unconfirmed against the real feed until a key exists.

**Coverage is the feed's, not a bug in this service, but unconfirmed
without a key.** Per the ICD, Israel Railways sends predictions but no
vehicle position at all; matching is by route, direction, scheduled
departure and service date, never by position (see
[`src/realtime/match.ts`](../src/realtime/match.ts)), and this API never puts
vehicle coordinates on a leg regardless, so the reasoning suggests a
heavy-rail leg's `realtime` should populate the same as a bus leg's once a
real key is in place. That reasoning has not been observed against the
real feed, so treat it as an expectation, not a
confirmed fact, until it is. **Jerusalem Light Rail is not in the feed at
all**: a light-rail leg's `realtime` is `null` unconditionally, the same
as any other trip SIRI never reports, and that is the service's coverage,
not a matching defect.
