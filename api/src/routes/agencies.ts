import type { FastifyPluginAsync } from "fastify";

export const agencyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/agencies", async () => {
    const rows = app.db.db.prepare(`
      SELECT agency_id, agency_name, agency_url, agency_timezone, agency_phone
      FROM agency ORDER BY agency_name
    `).all() as {
      agency_id: string; agency_name: string | null; agency_url: string | null;
      agency_timezone: string | null; agency_phone: string | null;
    }[];

    // Which `route_type`s each agency actually has routes for, so the app's
    // Operator and Vehicle-type chips can narrow each other instead of
    // offering combinations that return nothing.
    //
    // ONE grouped query, not one per agency: there are 36 agencies in the
    // real feed and this endpoint is hit on tab open, so 36 round trips to
    // SQLite would be paid every time the rider opens Lines.
    //
    // Grouped on the RAW `route_type`, matching what `/routes?type=` filters
    // on -- a value reported here must be one that comes back non-empty.
    // (`toBrief` reads a NULL `route_type` as bus, but `WHERE route_type IN
    // (3)` would not match such a row, and promising a chip that returns
    // nothing is the exact failure this field exists to prevent. No row in
    // the real feed has a NULL type.)
    const typeRows = app.db.db.prepare(`
      SELECT agency_id, route_type FROM routes
      WHERE agency_id IS NOT NULL AND route_type IS NOT NULL
      GROUP BY agency_id, route_type
      ORDER BY agency_id, route_type
    `).all() as { agency_id: string; route_type: number }[];

    const typesByAgency = new Map<string, number[]>();
    for (const r of typeRows) {
      const bucket = typesByAgency.get(r.agency_id);
      // GROUP BY has already made these distinct, and ORDER BY has already
      // put them in ascending order, so appending preserves both.
      if (bucket === undefined) typesByAgency.set(r.agency_id, [r.route_type]);
      else bucket.push(r.route_type);
    }

    return {
      agencies: rows.map((r) => ({
        agencyId: r.agency_id,
        name: r.agency_name,
        url: r.agency_url,
        timezone: r.agency_timezone,
        phone: r.agency_phone,
        // Ascending and distinct. `[]` for an agency with no routes at all,
        // never absent: the field is always present so a client can filter
        // on it without a defined-check.
        types: typesByAgency.get(r.agency_id) ?? [],
      })),
    };
  });
};
