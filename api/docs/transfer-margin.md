# The headway-scaled transfer margin

A flat 60-second boarding buffer (`TRANSFER_MIN_SECONDS`) treats a one-minute
connection with exactly the confidence of a twenty-minute one. Israeli buses
run late; a rider who misses a bus running every 6 minutes loses 6 minutes
and barely notices, but a rider who misses one running every 40 minutes
because the planner called 60 seconds enough loses the evening. The damage
is not proportional to the delay; it is proportional to the *next* headway
of the service being boarded, so the buffer required before boarding scales
with it:

```
required(headway) = clamp(TRANSFER_MIN_SECONDS, TRANSFER_HEADWAY_FACTOR * headway, TRANSFER_MAX_SECONDS)
```

It is a **clamp, not an addition**: the scaled figure REPLACES the base
buffer, and `TRANSFER_MIN_SECONDS` is only its floor. A 2-minute headway
scales to 30 s, which the floor raises to 60 s, not to 90 s. Below a
4-minute headway the rule therefore asks for exactly today's flat buffer and
nothing more.

With the defaults (base 60 s, factor 0.25, cap 600 s):

| Headway of the service being boarded | Required buffer |
| --- | --- |
| 2 min | 60 s (the floor; 0.25 × 120 s is only 30 s) |
| 5 min | 75 s |
| 6 min | 90 s |
| 20 min | 5 min |
| 40 min | 10 min (capped) |
| 60 min | 10 min (capped) |

Headway is measured per **(pattern, hour of service day)** from that day's
own active trips, never from the flat feed, which would make a Saturday
evening look as frequent as a Tuesday morning and under-buffer exactly when
missing is most expensive. An hour with no active departure, or the last
departure of the day, is unmeasurable and takes the cap: missing the last
service of the day is maximally expensive. `TRANSFER_HEADWAY_FACTOR=0`
disables all of this and restores the flat `TRANSFER_MIN_SECONDS` rule
exactly, byte-for-byte (see [Configuration](../README.md#configuration) above).

The rule applies only when **connecting from a vehicle**, never on the
journey's first boarding: there is no incoming vehicle to be late, so
buffering against one there would cost a real wait to insure against a delay
that cannot exist. It applies identically to `arriveBy`, with two accepted,
conservative-only approximations (never claims a connection is safer than it
is, only sometimes charges more margin than strictly required), and it changes what `transferAtRisk`
compares realtime predictions against, not just what RAPTOR itself requires.

**The guarantee: no query is left empty that the flat
`TRANSFER_MIN_SECONDS` rule could answer.** That is enforced in two layers.

Read that literally, because a stronger version of it was written here first
and does not hold. The planner *can* return **fewer** itineraries than the
flat rule: measured, 138 of 513 routable queries (26.9%) do, while 0 come
back empty. `stop:23093 → stop:43702` at `departAfter 20:55` is the worked
case: at factor 0 it returns four Pareto members arriving 23:28 / 22:30 /
22:25 / 22:14, and at 0.25 it returns two. The earliest arrival is gone
because its interchanges genuinely fail the margin, and since two members
survive the result is not empty, so the retry below never fires. **That is
the feature working**, not a gap in it; trading a faster-but-tighter option
away is what choosing reliability over speed means. The promise is about
empty screens, not about itinerary counts.

*Per connection.* The margin's whole justification is that a refused
connection just means the next trip on that pattern, and at the last
departure of the night there is no next trip, and the search does not roll
into the next morning. Measured, that cost 3.7% of randomly-drawn
late-evening `departAfter` queries their entire result (numbers below). So
when a boarding fails the scaled margin **and nothing later runs on that
pattern that service day**, the planner falls back to the flat buffer and
returns the journey.

*Per query.* Some journeys die to a *chain* of correct decisions: the margin
legitimately moves the rider onto a later trip at one interchange, and by the
time they get there a downstream last service has gone. No per-connection
rule can see that, so if the margin-respecting search returns **nothing at
all**, `/plan` re-runs the identical query at the flat rule and returns that
instead, in both directions.

The retry costs a second search on every empty result, which is not rare:
**212 of 725 drawn queries (29%) are empty at both factors**, because "no
journey found" is an ordinary late-night answer rather than a pathology. On
those queries the tail roughly doubles (p50 13.8 → 17.6 ms, p90 38.9 → 67.8
ms, p95 62.8 → 109.1 ms). An earlier version of this paragraph said "well
under 1% of queries", which was measured against a sample pre-filtered to
queries the flat rule could answer: the wrong denominator. Note too that
`TRANSFER_HEADWAY_FACTOR=0` is the only thing that skips the retry: at the
shipped default an unroutable query always searches twice, and that guard
exists to keep the off switch byte-exact, not to protect the unroutable
path.

Neither layer can make boarding easier than it was before this feature
existed, because the flat buffer *is* the pre-feature rule; both restore it
in exactly the case where the alternative is an empty result for someone
standing at a stop at 22:15. The rider is told either way: `transferAtRisk`
is `true` on any itinerary whose **scheduled** slack is under the margin the
rule wanted, whether or not realtime data exists, including on a retried
result, which is annotated against the configured margin, not the flat one it
was searched at.

`arriveBy` yields on the same terms, with an asymmetry:
the reverse search cannot ask "does anything depart after the instant I am
solving for", so it asks the sufficient question ("does anything run later
on this pattern at all today") and charges the full margin when it cannot
be sure. It errs toward an earlier departure, never a later one.

**Measured impact, factor 0 vs 0.25, against the live feed** (2026-08-24,
20 real queries spanning peak/off-peak/late-evening, central and peripheral:
Nahariya, Kiryat Shmona, Eilat, Mitzpe Ramon, Beer Sheva, Dimona, Tel
Aviv, Jerusalem, Haifa; both `departAfter` and `arriveBy`):

- **No query on this sample lost all its itineraries**, but the sample was
  20 hand-picked trunk intercity pairs, and that is precisely why. Those
  routes have overnight and next-morning fallbacks, so they structurally
  cannot exhibit the failure. A later, random sample did (see the
  last-service measurement below), and the claim that the margin only delays
  journeys and never removes them outright is false as an unconditional claim.
- **7 of 20 queries' best itinerary changed** (real duration or arrival
  moved later; none moved earlier). The rest were unaffected: high-frequency
  routes (Tel Aviv↔Haifa) saw no change at all, as intended.
- Where a journey did change, best-itinerary real duration grew by a median
  of 0s and a mean of 453s across all 20 queries (median 0s because 13 of 20
  were unaffected); among the 7 that changed, the increase ranged 615s–1800s.
  On **2 of those 7** (Beer Sheva→Kiryat Shmona and Tel Aviv→Mitzpe Ramon,
  both `arriveBy`), the real arrival was unchanged and the cost surfaced as
  an *earlier required departure* instead, because the reverse search holds
  the deadline fixed and maximises departure. The other 5, four of them
  `departAfter` (Haifa→Eilat's 615 s among them), simply arrived later. Both
  shapes are the same underlying trade on opposite ends of the chain; the
  direction of the query, not the size of the cost, decides which one a
  reader sees.
- **`/plan` latency**: median added latency was **+2.2 ms**; mean added
  latency was ~11 ms, almost entirely attributable to 2 of 20 queries where
  the extra margin changed which itineraries survived RAPTOR's Pareto filter,
  pulling in *additional* departure-reoptimisation passes
  (§`PLAN_REOPTIMISE_MAX_ITINERARIES` above), a pre-existing cost that scales
  with itinerary count, not a new cost from the margin computation itself.
- **Building a service day's headway table costs ~10–16 ms** the first time
  a process touches that day (measured directly against the live feed,
  6,901 patterns), and a memoised lookup thereafter costs ~0.004 ms, so a
  query touching both the current and previous service day (every query
  does) pays roughly 20–30 ms exactly once per process per day, never again
  until the next feed swap. The memo is doing its job: this is not a
  per-request cost.
- Already-known baseline, reconfirmed on this sample: even at factor 0, a
  meaningful share of itineraries carry a long wait between transit legs (3
  of 28 pooled itineraries here had a transfer wait over an hour at *both*
  factors). This feature does not create that shape; it makes the planner
  honest about the risk in the shorter waits it does return.

**Measured impact of the last-service rule** (2026-08-24, same feed; random
stop pairs 2–60 km apart, drawn against the factor-0 server and kept only
when it returned a journey, so every query below is one the pre-feature
planner could answer):

| Sample | Empty before | Per-connection layer | Both layers |
| --- | --- | --- | --- |
| 241 late-evening `departAfter` (20:00–23:15) | 9 (3.7%) | 1 (0.4%) | **0** |
| 120 daytime `departAfter` (09:00–16:00) | 0 | 0 | **0** |
| 120 late-evening `arriveBy` (21:00–23:59) | 0 | 0 | **0** |

124 of the 241 evening itineraries carry `transferAtRisk: true`. The single
case the per-connection layer could not reach is the worked example of the
chain effect: `stop:23879 → stop:29423` at 23:12 needs three tight
interchanges, and the first two are onto patterns that genuinely *do* run
again later, so no last-service fallback fires; the margin correctly moves
the rider onto those later trips, by which time the last services on the
final two legs have gone. The query-level retry answers it with the flat
rule's own journey, flagged.

At `TRANSFER_HEADWAY_FACTOR=0` the off switch remains exact: over those same
482 queries, `/plan`'s response bytes are identical to the commit before the
last-service rule landed.

The rule costs roughly **+6 ms on the median query** whose answer it does not
even change. That number is net of measurement bias, which is most of what a
naive reading would report: the raw before/after delta is +10.5 ms, but two
servers running *identical* code against the same 482 queries already differ
by +4.3 ms in the same direction, purely from which one the harness asks
first. The remaining cost is the boarding check's widened gate (see
`raptor.ts`) and the reverse pass's per-query last-service memo; the fallback
itself adds no second binary search, which was measured and then designed
out.
