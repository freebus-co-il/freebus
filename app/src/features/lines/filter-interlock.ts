/**
 * The Lines tab's two filters, as one closed system.
 *
 * The tab lets a rider pick operators and vehicle types at the same time,
 * which is exactly how a combination with no lines in it gets built (a rail
 * operator's buses) with nothing on screen to say why the list went empty.
 * The fix is not to warn afterwards but to make the impossible combination
 * unofferable: each drawer only ever lists what the other one's selection
 * leaves standing.
 *
 * All of it is pure and lives here rather than in the screen because it is
 * the only part of the filter that can actually be wrong.
 */

/** One operator and the vehicle types it runs, ascending -- exactly what
 *  `/agencies` returns per row, minus the fields the filter does not read. */
export type AgencyTypes = { agencyId: string; types: number[] };

function ascending(types: Iterable<number>): number[] {
  return [...new Set(types)].sort((a, b) => a - b);
}

/**
 * The feed minus one vehicle type: it is dropped from every operator, and an
 * operator left running nothing goes with it.
 *
 * The Lines tab excludes rail this way. A rail route carries an empty
 * `route_short_name` and no line code, so each one lands as an unnamed,
 * ungroupable "line" crowding out the numbered ones -- and an operator that
 * runs nothing else has no lines to show on this tab at all.
 */
export function excludeType(all: AgencyTypes[], type: number): AgencyTypes[] {
  return all
    .map((agency) => ({ ...agency, types: agency.types.filter((value) => value !== type) }))
    .filter((agency) => agency.types.length > 0);
}

/**
 * The vehicle types the Vehicle-type drawer may offer.
 *
 * An empty operator selection is NO constraint, not "no operators", so it
 * yields every type the feed runs.
 */
export function typesForAgencies(all: AgencyTypes[], selectedAgencyIds: string[]): number[] {
  const source = selectedAgencyIds.length === 0
    ? all
    : all.filter((agency) => selectedAgencyIds.includes(agency.agencyId));
  return ascending(source.flatMap((agency) => agency.types));
}

/**
 * The operators the Operator drawer may offer: those running at least one of
 * the picked types. An empty type selection is again no constraint.
 *
 * Feed order is preserved, so the drawer does not reshuffle itself under the
 * rider's finger as they tick types.
 */
export function agenciesForTypes(all: AgencyTypes[], selectedTypes: number[]): AgencyTypes[] {
  if (selectedTypes.length === 0) return all;
  return all.filter((agency) => agency.types.some((type) => selectedTypes.includes(type)));
}

/**
 * The single vehicle type a set of operators is pinned to, if there is one.
 *
 * When the picked operators run exactly one kind of vehicle, the type filter
 * has nothing left to decide: every answer but that one is empty. The screen
 * says so by disabling the chip and naming the type, rather than opening a
 * drawer with one row that cannot be unticked.
 *
 * Null while nothing is picked, because an empty selection is a constraint
 * the rider has not expressed -- there is nothing to lock them into yet.
 */
export function lockedType(all: AgencyTypes[], selectedAgencyIds: string[]): number | null {
  if (selectedAgencyIds.length === 0) return null;
  const types = typesForAgencies(all, selectedAgencyIds);
  return types.length === 1 ? types[0] : null;
}

/**
 * What `/routes` is actually asked for, once the interlock has had its say.
 *
 * A lock wins outright: the operators can only run that type, so whatever the
 * rider ticked before they narrowed the operators no longer describes
 * anything. Otherwise their picks stand, minus any type the chosen operators
 * do not run.
 *
 * The drawers cannot produce a selection that prunes down to nothing, so the
 * empty case here is belt and braces: it sends no type constraint rather than
 * one that could only come back empty.
 *
 * The lock is deliberately NOT fed back into `agenciesForTypes`. It is the
 * interlock's own inference, not something the rider chose, and treating it as
 * a type filter would freeze the Operator drawer down to whoever runs the
 * locked type -- leaving no way back out to a different kind of operator.
 */
export function effectiveTypes(
  all: AgencyTypes[],
  selectedAgencyIds: string[],
  selectedTypes: number[],
): number[] {
  const locked = lockedType(all, selectedAgencyIds);
  if (locked !== null) return [locked];
  if (selectedTypes.length === 0) return [];
  const available = typesForAgencies(all, selectedAgencyIds);
  return ascending(selectedTypes.filter((type) => available.includes(type)));
}
