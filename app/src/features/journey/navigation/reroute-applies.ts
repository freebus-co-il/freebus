/**
 * Whether a walk re-route still belongs to the walk on screen: the same leg,
 * AND the same place it leads to. A live re-plan can keep the leg's index
 * while moving the stop the rider should walk to, and a re-route toward the
 * old stop would keep steering them to where their bus no longer leaves from.
 */
export function rerouteApplies(
  reroute: { legIndex: number; to: { lat: number; lon: number } },
  legIndex: number,
  leg: { to: { lat: number; lon: number } } | null,
): boolean {
  return leg !== null && reroute.legIndex === legIndex && reroute.to.lat === leg.to.lat && reroute.to.lon === leg.to.lon;
}
