import { runRaptor, type Label, type RaptorAccess } from "../../transit/raptor.js";
import {
  runRaptorReverse, type ReverseLabel, type ReverseQuery,
} from "../../transit/raptorReverse.js";
import {
  paretoRounds, reconstructForward, reconstructReverseChain, hasRidden, hasRiddenReverse,
  type Itinerary,
} from "../../transit/itinerary.js";
import type { TimetableIndex } from "../../transit/index.js";
import type { TransferMargin } from "../../transit/headway.js";
import type { TimetableShift } from "../../transit/shift.js";
import { planConfig, rankConfig } from "../../config.js";
import { reoptimiseBounded } from "../reoptimise.js";
import { maxTransferWaitSeconds } from "./transferRisk.js";

/**
 * How far before an `arriveBy` deadline an itinerary may arrive before it is
 * dropped. The search spans today and yesterday (for trips past midnight), so
 * with no service today it can satisfy "arrive by 08:05" with yesterday's
 * 08:00 bus. The two-day context can legitimately be at most ~24 h early.
 */
export const ARRIVE_BY_MAX_LOOKBACK_SECONDS = 24 * 3600;

/**
 * The longest single wait between two rides allowed in a reverse-built
 * itinerary (`arriveBy`, and the `departAfter` probe). Measured on the real
 * feed: the largest genuine wait is 10.29 h and the smallest overnight
 * artefact is 12.81 h, with nothing in between, so 12 h sits in the gap. The
 * bound is on the wait, not on `durationSeconds`, which on `arriveBy` grows
 * with the deadline rather than the journey. See docs/planner-notes.md.
 */
export const ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS = 12 * 3600;

/** Live delays for the query's service days, or undefined for schedule only. */
export type LiveShift = (TimetableShift | undefined)[] | undefined;

/** The query fields every RAPTOR call in one request shares. One object, so
 *  `transfer`, `days`, `tripFilter` and `shift` cannot be forgotten on one
 *  call site. */
export type SharedQuery = Omit<ReverseQuery, "arriveByEpoch" | "maxRounds"> & {
  transfer: TransferMargin;
};

/** A candidate set. All three arrays are parallel, index for index. */
export interface SearchResult {
  itineraries: Itinerary[];
  /** Built by the reverse pass, so its transfers are priced by the reverse
   *  rule (see `requiredMarginFor`). */
  reverseSourced: boolean[];
  /** Came from the `departAfter` reverse probe, so its arrival is already
   *  bounded and it is exempt from the departure window when ranking. Not the
   *  same as `reverseSourced`, which a reoptimised forward itinerary also
   *  sets. */
  probeSourced: boolean[];
}

export interface SearchContext {
  ix: TimetableIndex;
  tz: string;
  arriveBy: boolean;
  /** The query instant: the deadline for `arriveBy`, the earliest departure
   *  otherwise. */
  atEpoch: number;
  results: number;
  maxRounds: number;
  baseQuery: SharedQuery;
  /** The request's configured margin. The wait bound is gated on THIS
   *  factor, not the pass's, so the flat second pass keeps the bound. */
  transfer: TransferMargin;
  /** Builds an itinerary from a travel-ordered chain. Access defaults to the
   *  chain's first stop. */
  build: (
    chain: { stopIdx: number; label: Label }[], live: LiveShift, accessStopIdx?: number,
  ) => Itinerary;
}

/** Reverse labels carry latest departures; `paretoRounds` minimises an
 *  arrival, so it is fed `-departureEpoch`. The returned `arrivalEpoch` is
 *  that negated value and must not be read as a time. */
function reversePicks(
  rounds: readonly (readonly (ReverseLabel | null)[])[], origins: readonly RaptorAccess[],
): { round: number; stopIdx: number }[] {
  return paretoRounds(
    rounds.map((round) => round.map((l) =>
      l === null ? null : { arrivalEpoch: -l.departureEpoch, src: l })),
    origins,
    // Round 0 is walk-only and is never returned, so it must not win a pick.
    { accept: (c) => hasRiddenReverse(c.src) },
  );
}

function waitTooLong(ctx: SearchContext, itinerary: Itinerary): boolean {
  return ctx.transfer.cfg.factor !== 0
    && maxTransferWaitSeconds(itinerary.legs) > ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS;
}

/**
 * One complete plan at ONE transfer margin: the RAPTOR pass for this query's
 * direction, the Pareto pick, chain reconstruction and, for `departAfter`,
 * re-anchoring, reoptimisation and the reverse probe.
 */
export function search(ctx: SearchContext, margin: TransferMargin, live: LiveShift): SearchResult {
  const { ix, maxRounds, results, atEpoch } = ctx;
  const query = { ...ctx.baseQuery, transfer: margin, shift: live };
  const out: SearchResult = { itineraries: [], reverseSourced: [], probeSourced: [] };
  const push = (itinerary: Itinerary, reverse: boolean, probe: boolean): void => {
    out.itineraries.push(itinerary);
    out.reverseSourced.push(reverse);
    out.probeSourced.push(probe);
  };

  if (ctx.arriveBy) {
    const res = runRaptorReverse(ix, { ...query, arriveByEpoch: atEpoch, maxRounds });
    for (const pick of reversePicks(res.rounds, query.origins).slice(0, results)) {
      const chain = reconstructReverseChain(ix, res.rounds, pick.round, pick.stopIdx);
      if (chain === null) continue;
      const itin = ctx.build(chain, live, pick.stopIdx);
      if (Date.parse(itin.arrivalTime) / 1000 < atEpoch - ARRIVE_BY_MAX_LOOKBACK_SECONDS) continue;
      if (waitTooLong(ctx, itin)) continue;
      push(itin, true, false);
    }
    return out;
  }

  const res = runRaptor(ix, { ...query, departAfterEpoch: atEpoch, maxRounds });
  const buildFrom = (chain: { stopIdx: number; label: Label }[]): Itinerary =>
    ctx.build(chain, live);

  for (const pick of paretoRounds(res.rounds, query.destinations, { accept: hasRidden })
    .slice(0, results)) {
    const chain = reconstructForward(ix, res.rounds, pick.round, pick.stopIdx);
    if (chain === null) continue;
    // Re-anchoring on the first boarding always runs; the reverse-pass
    // refinement only for the first `reoptimiseMaxItineraries` in search
    // order. See reoptimise.ts.
    const raw = buildFrom(chain);
    const built = reoptimiseBounded(
      out.itineraries.length, planConfig.reoptimiseMaxItineraries, raw,
      { ix, tz: ctx.tz, reverseQuery: query, buildFrom },
    );
    // Re-anchoring is a shallow spread that keeps `legs`; only a swap onto a
    // reverse-built chain replaces it. So this is exact.
    push(built, built.legs !== raw.legs, false);
  }

  // The reverse probe. The forward pass minimises arrival, so a journey that
  // leaves later and arrives later is dominated and never surfaces. Running
  // the reverse pass at a relaxed deadline finds it, at one extra pass per
  // probe regardless of window width.
  if (out.itineraries.length === 0) return out;
  const earliestArrivalEpoch =
    Math.min(...out.itineraries.map((i) => Math.floor(Date.parse(i.arrivalTime) / 1000)));
  for (let probe = 1; probe <= rankConfig.reverseProbes; probe++) {
    // Spread evenly up to `earliestArrival + window`.
    const deadline = earliestArrivalEpoch
      + Math.round(rankConfig.departureWindowSeconds * probe / rankConfig.reverseProbes);
    const rev = runRaptorReverse(ix, { ...query, arriveByEpoch: deadline, maxRounds });
    for (const pick of reversePicks(rev.rounds, query.origins).slice(0, results)) {
      const chain = reconstructReverseChain(ix, rev.rounds, pick.round, pick.stopIdx);
      if (chain === null) continue;
      const candidate = buildFrom(chain);
      // LOAD-BEARING: the reverse pass has no lower bound on departure, so it
      // can return a bus that left before the rider asked to travel.
      if (Math.floor(Date.parse(candidate.departureTime) / 1000) < atEpoch) continue;
      // The lookback bound is not needed: the check above is stronger here.
      if (waitTooLong(ctx, candidate)) continue;
      push(candidate, true, true);
    }
  }
  return out;
}

/**
 * The configured margin, merged with the same search at the flat buffer.
 *
 * Applying the headway-scaled margin as a hard gate lost real journeys: it
 * moves a rider onto a later trip at one interchange and the last service
 * downstream is gone, or turns a missed 15-minute headway into a 45-minute
 * detour. Merging both candidate sets (ranking dedupes and orders them) keeps
 * every margin-respecting journey and adds the flat ones, which
 * `annotateTransferRisk` then flags. Measured cost and benefit are in
 * docs/planner-notes.md.
 *
 * `factor === 0` is the off switch: one search, byte-identical to the flat
 * planner.
 */
export function searchBoth(ctx: SearchContext, live: LiveShift): SearchResult {
  const strict = search(ctx, ctx.transfer, live);
  if (ctx.transfer.cfg.factor === 0) return strict;
  // Same `headway` tables: they must stay parallel to `days`, and a zero
  // factor never reads them.
  const flat: TransferMargin = { cfg: { ...ctx.transfer.cfg, factor: 0 }, headway: ctx.transfer.headway };
  const relaxed = search(ctx, flat, live);
  return {
    itineraries: strict.itineraries.concat(relaxed.itineraries),
    reverseSourced: strict.reverseSourced.concat(relaxed.reverseSourced),
    probeSourced: strict.probeSourced.concat(relaxed.probeSourced),
  };
}
