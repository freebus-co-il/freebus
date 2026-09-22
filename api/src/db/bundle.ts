import { openTransitDbAtPath, type DbHandle } from "./connect.js";
import { Translator } from "./i18n.js";
import { loadCalendar, type CalendarRow } from "../transit/calendar.js";

export interface RouteBriefByIdx {
  id: string; agencyId: string | null; shortName: string | null;
  longName: string | null; type: number; color: string | null;
}

/**
 * Everything a route handler reads from the live database OUTSIDE the RAPTOR
 * index: the raw connection, translations, the active calendar, and a
 * route-index-aligned brief/type lookup (parallel to `TimetableIndex`'s own
 * `routeIds` ordering — `ORDER BY route_id`, exactly as `buildIndex` orders
 * it — so `/plan` can resolve a transit leg's route without a database query
 * per leg).
 *
 * Built as one unit from one resolved path and swapped as one unit by
 * `IndexManager` (see its class comment). Refreshing these fields
 * independently of one another — or independently of the RAPTOR index —
 * is exactly the bug this type exists to make structurally impossible: a
 * request could otherwise read, say, a route's `type` from a newly swapped
 * feed while every stop name still came from the previous one.
 */
export interface AppBundle {
  db: DbHandle;
  translator: Translator;
  calendar: CalendarRow[];
  routeBriefByIdx: RouteBriefByIdx[];
  routeTypeByIdx: number[];
}

/**
 * Builds a fresh `AppBundle` from an already-resolved database path — see
 * `openTransitDbAtPath`'s comment for why the caller, not this function,
 * must be the one to resolve the live symlink.
 */
export function buildAppBundle(dbPath: string, target: string): AppBundle {
  const db = openTransitDbAtPath(dbPath, target);

  const translator = Translator.load(db.db);
  const calendar = loadCalendar(db.db);

  const routeRows = db.db.prepare(`
    SELECT route_id, agency_id, route_short_name, route_long_name, route_type, route_color
    FROM routes ORDER BY route_id
  `).all() as {
    route_id: string; agency_id: string | null;
    route_short_name: string | null; route_long_name: string | null;
    route_type: number | null; route_color: string | null;
  }[];

  return {
    db,
    translator,
    calendar,
    routeBriefByIdx: routeRows.map((r) => ({
      id: r.route_id, agencyId: r.agency_id,
      shortName: r.route_short_name, longName: r.route_long_name,
      type: r.route_type ?? 3, color: r.route_color === "" ? null : r.route_color,
    })),
    routeTypeByIdx: routeRows.map((r) => r.route_type ?? 3),
  };
}
