# Known limitations

These are real, deliberate, and documented here so a caller does not have
to rediscover them by surprise:

1. **Line names are Hebrew regardless of `lang`.** `routes.route_long_name`
   has **zero** translation coverage in this feed; no amount of
   `?lang=en` changes it, because the feed ships no translation rows for
   it at all. Stop names fare much better (~92.4% translated); the
   remaining ~7.6% fall back to the Hebrew feed text rather than returning
   blank.
2. **`departureTime`/`arrivalTime` are door-to-door**, anchored on the
   whole itinerary chain including walk legs (see [Planning](../README.md#planning)
   above). They deliberately differ from `legs[0].from.departureTime`.
   Door-to-door is a statement about *which end of the chain* they measure,
   and (in both modes, as of the departure-reoptimisation pass described
   under [Planning](../README.md#planning)) `departureTime` really is a "leave at" time.
3. **Walk legs carry no `geometryFallback` field at all**: it is a
   transit-leg field, so on a walk leg it reads back as `undefined`, not
   `false`. Neither `geometry` nor `walkEstimated` is a foregone conclusion
   any more, and the two are set independently, by two different
   mechanisms:
   - **Geometry.** Every walk leg, access/egress and mid-itinerary
     transfer alike, is routed through a per-request Valhalla `/route`
     call by `resolveWalkGeometry` (see
     [`src/routes/walkGeometry.ts`](../src/routes/walkGeometry.ts)) after the
     itinerary is built. When that call succeeds, the leg's `geometry`
     becomes a real **precision-6 encoded polyline string** and its
     `distanceMeters` becomes the real routed distance; when it fails,
     times out, or the response doesn't parse, the leg keeps
     `geometry: null` and the haversine × 1.35 `distanceMeters` estimate it
     started with. `resolveWalkGeometry` never touches `durationSeconds`.
   - **`walkEstimated`.** This reflects a leg's *duration*, not its
     distance or geometry: it is `true` **iff `durationSeconds` is not a
     real routed walking time**, decided once when the leg is built and
     never touched by `resolveWalkGeometry` afterwards (that function has
     no way to know whether a duration it never computes is real; see its
     own doc comment). The rule differs by leg kind:
     - An **access or egress** leg (connecting a `lat,lon` endpoint to its
       first or last stop) reports `walkEstimated: false` once
       [`refineAccessByWalking`](../src/routes/accessRefine.ts) has routed
       that candidate through a live Valhalla `/sources_to_targets` matrix
       call (the same real duration RAPTOR planned the itinerary with)
       and stays `true`, at the old 1.33 m/s estimate, whenever that call
       failed, timed out, or came back malformed.
     - A **mid-itinerary street transfer** leg (between two transit legs,
       not a same-station interchange) reports `walkEstimated: false`
       exactly when the currently-served index's footpaths were routed
       through Valhalla rather than the straight-line fallback, the same
       fact `/meta`'s `footpaths: "valhalla"` reports, since both trace
       back to the identical `FootpathMode` `IndexManager` computed when it
       last (re)attached footpaths (see
       [`src/transit/manager.ts`](../src/transit/manager.ts)'s
       `attachFootpathsTo`). A Valhalla outage that drops the whole index
       into `"footpaths": "straight-line"` (point 6 below) is therefore
       visible on every affected transfer leg too, not just at `/meta`.
       **This flag is index-wide, not per-edge, and can over-claim on an
       individual edge**: `buildFootpaths` falls back to a straight-line
       estimate for any single stop pair whose own Valhalla matrix cell
       came back null or non-finite (near a barrier the street graph
       cannot route across, for instance) while the index as a whole stays
       in `"valhalla"` mode. That one pair's transfer leg then reports
       `walkEstimated: false` alongside every genuinely routed edge around
       it. Per-edge provenance is a recorded follow-up, not yet built.
     - A **same-station interchange** (walking between two platforms of the
       same station) reports `walkEstimated: true` unconditionally, even on
       a fully routed index: its duration is always the configured
       `sameStationSeconds + transferMinSeconds` constant, never a routed
       street walk (see [`src/transit/footpaths.ts`](../src/transit/footpaths.ts)'s
       `stationPeers`).

     Because `distanceMeters`/`geometry` (resolved independently, and
     possibly later, by `resolveWalkGeometry`'s own per-request `/route`
     call) and `durationSeconds`/`walkEstimated` (decided once at leg
     construction, by an entirely different mechanism) do not share a data
     source, a leg's implied speed can still be a little off even when
     both fields are individually correct: e.g. a street transfer on a
     straight-line-mode index can get a real routed `geometry` while
     `walkEstimated` correctly stays `true`, because the DURATION is still
     the footpath-matrix estimate regardless of what the per-request
     geometry call found.

   Transit legs, by contrast, do carry real geometry sliced from the
   operator's own shape
   when one exists, with `geometryFallback: true` flagging a straight line
   through the leg's stops instead. A leg's `geometry` is a precision-6
   encoded polyline string on both transit and walk legs, not the GeoJSON
   `LineString` that `GET /routes/:routeId/shape` returns, a deliberate
   difference, far more compact than GeoJSON in a response that can carry
   several legs at once.
4. **Train lines are OpenStreetMap's track, not the operator's shape.** The
   feed ships no shape for any rail trip (every `route_type` 2 trip, and no
   trip of any other type), so rail legs, route shapes and trip detail are
   drawn along lines baked from OSM (see [Train track lines](how-it-works.md#train-track-lines)).
   They carry `geometryFallback: false`, because they are the real alignment,
   but they are only as current as the last `npm run bake:rail`: a station
   pair added to the feed since then is drawn through its stations with
   `geometryFallback: true` until the next bake. Buses, light rail and the
   rest are unaffected; their legs are cut from the operator's own polyline.
5. **`arriveBy` applies a 24-hour lookback bound**, not a same-day one: an
   itinerary is discarded only if its arrival is more than 24 hours before
   the deadline. An ordinary previous-day trip that happens to satisfy the
   deadline well inside that 24-hour bound (e.g. a Friday 08:30 deadline
   answered by a Thursday 09:00→09:10 trip) can still be returned. This
   under-filters; it never over-filters a legitimate late-night
   (`25:30`-style) wraparound trip, which is what the bound exists to
   protect.
6. **A Valhalla outage runs the whole service in a degraded straight-line
   footpath mode**, visible as `"footpaths": "straight-line"` in
   `GET /meta`. This is not silently masked, and it is not permanent: only
   a real Valhalla result is ever written to the footpath cache, so a
   transient outage at one boot does not poison every later restart.
7. **A rare RAPTOR suboptimality**: at a stop where a transit arrival is
   nominally earlier but a walk arrival is *ready* earlier (footpath
   costs already fold in the transfer buffer, while a transit arrival
   still owes it), the label-selection tie-break can keep the transit
   label and miss a downstream connection the walk would have made in
   time. Measured at about 1 in 36,000 random synthetic networks during
   review's differential testing against a brute-force oracle. This is a
   known, deliberately unfixed edge: the correct fix is a two-label model
   per stop (best-arrival for egress, best-readiness for onward boarding),
   which is a design change, not a one-line patch, on an engine now
   verified correct over 100,000+ other networks. See
   `raptor.ts`/`raptorReverse.ts` and the oracle tests for the full trail.
8. **`/plan/onboard` names the EARLIEST visit on a loop.** When the rider's
   own trip calls at the same stop twice after `onTripFromStop` (a loop
   pattern), RAPTOR keeps only the earlier of the two seeds, so a journey
   whose onward connection leaves at 08:36 reports `alightAt` at 08:10
   rather than 08:30: the rider is told to get off twenty minutes before
   they need to, and `durationSeconds` is inflated by the same twenty
   minutes. The journey itself is real and makeable (they simply wait at
   the stop rather than on the bus), so this errs in the safe direction,
   but it is not the nicest answer. Fixing it means keeping two visits to
   one stop distinguishable through RAPTOR's per-stop label arrays, i.e.
   abandoning the single-best-label-per-stop model the whole engine rests
   on. Relatedly, `query.alightStops` counts SEEDS, not distinct stops, so
   such a trip reports one more than it has physical alighting points.
