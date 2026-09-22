/** The fields grouping actually reads. Structural on purpose, so this stays
 *  a pure module testable without the API types or a network shape. */
export type RoutesToGroup = {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  agencyId: string | null;
  type: number;
  /** Optional because an API deploy older than the Lines tab omits it
   *  entirely. Such rows cannot be addressed as a line and are dropped. */
  desc?: string | null;
};

/**
 * One public line: the thing a rider means by "line 18", assembled from the
 * several route rows the feed splits it into.
 */
export type Line = {
  /** The line's identity, as `lineKeyOf` produces it and as
   *  `GET /lines/:lineCode` resolves it: a ministry line code for bus, and
   *  `route:<routeId>` for rail. This is the value a row navigates with. */
  lineCode: string;
  /** Null for rail, whose rows carry an empty `route_short_name`. Render
   *  `longName` instead when this is null. */
  shortName: string | null;
  longName: string | null;
  agencyId: string | null;
  type: number;
  /** Every route row that makes up this line, in the order encountered. */
  routeIds: string[];
};

/**
 * The ministry line code inside `route_desc`: the text before the first
 * `-`, or the whole value when there is none.
 *
 * MUST stay identical to `LINE_CODE_SQL` in the API's `db/lines.ts`. The
 * two are one contract split across the wire: the API orders route rows by
 * that expression precisely so a line's rows arrive adjacent, and grouping
 * here by a different rule would silently split lines across page
 * boundaries that the ordering was supposed to prevent.
 *
 * This is the SORT-key half of that contract only. What IDENTIFIES a line
 * is `lineKeyOf`, which differs for rail -- see there.
 */
export function lineCodeOf(desc: string | null | undefined): string | null {
  // `undefined` as well as `null`: this app ships separately from the single
  // box it talks to, so it routinely runs against an API deploy that predates
  // a field it asks for. `desc` arrived with the Lines tab, and a server
  // without it sends no key at all rather than a null one -- guarded here so
  // that does not throw and take the whole tab down.
  if (desc === null || desc === undefined) return null;
  const dash = desc.indexOf('-');
  return dash === -1 ? desc : desc.slice(0, dash);
}

/**
 * A line's identity: the ministry line code for a dashed `desc` (every bus
 * row), and `route:<routeId>` for an undashed one (every rail row).
 *
 * A rail row's bare desc is NOT its identity. 32 of those bare values are
 * carried by two route rows each in the real feed -- desc '1' is both route
 * 38450 (נהריה<->נתב"ג) and route 44031 (נהריה<->מודיעין מרכז), which are
 * different services. Keying on the desc merges them into one line, and the
 * API's `/lines/:lineCode` then keeps only the route row with more stops,
 * so the other service vanishes. Rail carries no line identity in this feed:
 * the route row is the line.
 *
 * MUST stay identical to `LINE_KEY_SQL` in the API's `db/lines.ts`. What
 * this returns is both the grouping key and the value the row navigates
 * with, so a divergence produces list rows whose line page 404s.
 */
export function lineKeyOf(route: { desc?: string | null; routeId: string }): string {
  // `desc` may be absent entirely, not merely null, when the API deploy
  // predates the Lines tab -- see `lineCodeOf`. Such a row still gets a
  // `route:` key and stays addressable, rather than taking the tab down.
  const code = route.desc === null || route.desc === undefined || !route.desc.includes('-')
    ? null
    : lineCodeOf(route.desc);
  return code === null || code === '' ? `route:${route.routeId}` : code;
}

/**
 * Collapses route rows into lines, preserving the order they arrive in.
 *
 * ALWAYS call this over the whole accumulated list, never page by page. The
 * feed stores one route row per direction per alternative, so a line's rows
 * can straddle a page boundary; grouping each page in isolation would emit
 * the same line twice and never merge them. Grouping the accumulator means
 * a straddled line folds together the moment its next page lands, and only
 * the final line of the loaded tail is ever provisional.
 */
export function groupRoutes(routes: readonly RoutesToGroup[]): Line[] {
  const byCode = new Map<string, Line>();

  for (const route of routes) {
    // The IDENTITY key, not the sort key: two rail rows sharing a bare desc
    // are two different services and must stay two lines. `lineKeyOf` is
    // also what `/lines/:lineCode` resolves, so the key a line is grouped
    // under is exactly the value its row navigates with. A row with no desc
    // at all still gets a usable key from its route id, so nothing is
    // dropped here any more.
    const lineCode = lineKeyOf(route);

    const existing = byCode.get(lineCode);
    if (existing !== undefined) {
      existing.routeIds.push(route.routeId);
      continue;
    }

    byCode.set(lineCode, {
      lineCode,
      shortName: route.shortName === null || route.shortName === '' ? null : route.shortName,
      longName: route.longName,
      agencyId: route.agencyId,
      type: route.type,
      routeIds: [route.routeId],
    });
  }

  return [...byCode.values()];
}
