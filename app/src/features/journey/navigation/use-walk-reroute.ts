import { useEffect, useRef, useState } from 'react';

import type { WalkLeg, WalkStep } from '@/api/types';
import { fetchWalk } from '@/api/walk';
import { decodePolyline } from '@/lib/polyline';

import type { RiderPosition } from '../types';
import { shouldReroute } from './reroute';
import { walkGuidance, type Point } from './walk-guidance';

export type WalkRoute = {
  /** The line to guide along: the re-route when there is one, else the leg's own. */
  path: Point[];
  steps: readonly WalkStep[];
  /** The re-route's encoded line, for the map to draw in place of the leg's. */
  reroutedGeometry: string | null;
  rerouting: boolean;
};

type Reroute = { legIndex: number; geometry: string; steps: WalkStep[] };

/** How often an off-route rider with no new fix is looked at again. */
const RECHECK_MS = 3_000;

function pathOf(geometry: string | null, leg: WalkLeg): Point[] {
  if (geometry) {
    const decoded = decodePolyline(geometry).map(([lat, lon]) => ({ lat, lon }));
    if (decoded.length >= 2) return decoded;
  }
  return [leg.from, leg.to];
}

/**
 * The walk a rider is being guided along, re-planned from where they are when
 * they leave it.
 *
 * Off the line for long enough (see `shouldReroute`), it asks the server for the
 * rest of the way to the same place, and guides along that instead -- until the
 * leg changes, when the re-route is dropped with it. A re-route that comes back
 * as a straight-line estimate is not taken: it has no turns, and the planned
 * walk still points at the stop.
 */
export function useWalkReroute({ legIndex, leg, fix }: {
  legIndex: number;
  leg: WalkLeg | null;
  fix: RiderPosition | null;
}): WalkRoute | null {
  const [reroute, setReroute] = useState<Reroute | null>(null);
  const [pendingLegIndex, setPendingLegIndex] = useState<number | null>(null);
  // Bumped when an off-route rider has been off long enough to re-route. A
  // rider who strays and then stands still sends no new fix, and without this
  // nothing would ever look again.
  const [recheck, setRecheck] = useState(0);
  const offRouteSince = useRef<string | null>(null);
  const lastRerouteAt = useRef<string | null>(null);
  const currentLegIndex = useRef(legIndex);

  const active = reroute !== null && reroute.legIndex === legIndex ? reroute : null;

  useEffect(() => {
    currentLegIndex.current = legIndex;
    offRouteSince.current = null;
  }, [legIndex]);

  useEffect(() => {
    if (!leg || !fix) return;
    const guidance = walkGuidance(pathOf(active?.geometry ?? leg.geometry, leg), active?.steps ?? leg.steps ?? [], fix);
    if (!guidance?.offRoute) {
      offRouteSince.current = null;
      return;
    }
    offRouteSince.current ??= fix.at;
    const now = new Date();
    if (!shouldReroute({
      offRouteSince: offRouteSince.current, lastRerouteAt: lastRerouteAt.current, accuracyMeters: fix.accuracyMeters, now,
    })) {
      const timer = setTimeout(() => setRecheck((count) => count + 1), RECHECK_MS);
      return () => clearTimeout(timer);
    }

    lastRerouteAt.current = now.toISOString();
    const requestedFor = legIndex;
    void Promise.resolve()
      .then(() => {
        setPendingLegIndex(requestedFor);
        return fetchWalk(fix, leg.to);
      })
      .then((walk) => {
        // A leg finished while the request was out: its re-route is no use now.
        if (currentLegIndex.current !== requestedFor || walk.estimated || !walk.geometry) return;
        setReroute({ legIndex: requestedFor, geometry: walk.geometry, steps: walk.steps });
        offRouteSince.current = null;
      })
      .catch(() => {
        // Offline or refused: keep guiding along the walk already on screen.
      })
      .finally(() => setPendingLegIndex((pending) => (pending === requestedFor ? null : pending)));
  }, [leg, legIndex, fix, active, recheck]);

  if (!leg) return null;
  return {
    path: pathOf(active?.geometry ?? leg.geometry, leg),
    steps: active?.steps ?? leg.steps ?? [],
    reroutedGeometry: active?.geometry ?? null,
    rerouting: pendingLegIndex === legIndex,
  };
}
