/**
 * A route row's line identity, from its `route_desc` -- the TypeScript twin of
 * `LINE_KEY_SQL` in `lines.ts`, for code that already holds a row and would
 * otherwise re-query the database just to name its line. The two MUST agree;
 * `lineKey.test.ts` holds them to it over the fixture's routes.
 *
 * The ministry line code (the desc's first field) for a bus row, and
 * `route:<route_id>` for a row with no dashed desc -- every rail row, whose
 * bare descs are shared across different services and so cannot name a line.
 */
export function lineKeyOf(routeId: string, desc: string | null): string {
  const dash = desc === null ? -1 : desc.indexOf("-");
  return dash > 0 ? desc!.slice(0, dash) : `route:${routeId}`;
}

/** `route_desc`'s direction digit, or "1" when the desc has no direction
 *  field at all (every rail row). The key a line's directions are told apart
 *  by -- never GTFS `direction_id`, which maps digits 1 and 3 onto one value. */
export function lineDirectionOf(desc: string | null): string {
  if (desc === null) return "1";
  const parts = desc.split("-");
  return parts.length > 1 ? parts[1]! : "1";
}
