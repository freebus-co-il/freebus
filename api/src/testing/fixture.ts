import Database from "better-sqlite3";
import { join } from "node:path";
import { symlinkSync } from "node:fs";

const VERSION = "2026-08-21T16-10-22-006Z";

const DDL = `
CREATE TABLE agency (agency_id TEXT PRIMARY KEY, agency_name TEXT, agency_url TEXT,
  agency_timezone TEXT, agency_lang TEXT, agency_phone TEXT, agency_fare_url TEXT);
CREATE TABLE routes (route_id TEXT PRIMARY KEY, agency_id TEXT, route_short_name TEXT,
  route_long_name TEXT, route_desc TEXT, route_type INTEGER, route_color TEXT);
CREATE TABLE stops (stop_ref INTEGER PRIMARY KEY, stop_id TEXT NOT NULL UNIQUE,
  stop_code TEXT, stop_name TEXT, stop_desc TEXT, stop_lat REAL, stop_lon REAL,
  location_type INTEGER, parent_station TEXT, zone_id TEXT);
CREATE TABLE calendar (service_id TEXT PRIMARY KEY, sunday INTEGER, monday INTEGER,
  tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER,
  saturday INTEGER, start_date INTEGER, end_date INTEGER);
CREATE TABLE trips (trip_ref INTEGER PRIMARY KEY, trip_id TEXT NOT NULL UNIQUE,
  route_id TEXT, service_id TEXT, trip_headsign TEXT, direction_id INTEGER,
  shape_id TEXT, wheelchair_accessible INTEGER);
CREATE TABLE stop_times (trip_ref INTEGER NOT NULL, stop_ref INTEGER NOT NULL,
  stop_sequence INTEGER NOT NULL, arrival_time INTEGER, departure_time INTEGER,
  pickup_type INTEGER, drop_off_type INTEGER, shape_dist_traveled REAL);
CREATE TABLE shapes (shape_id TEXT PRIMARY KEY, encoded_polyline TEXT NOT NULL,
  point_count INTEGER NOT NULL, total_length_m REAL NOT NULL);
CREATE TABLE translations (trans_id TEXT NOT NULL, lang TEXT NOT NULL,
  translation TEXT, PRIMARY KEY (trans_id, lang));
CREATE TABLE feed_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX ix_stop_times_stop_dep ON stop_times (stop_ref, departure_time);
CREATE INDEX ix_stop_times_trip_seq ON stop_times (trip_ref, stop_sequence);
CREATE INDEX ix_trips_route   ON trips (route_id);
CREATE INDEX ix_trips_service ON trips (service_id);
CREATE INDEX ix_stops_code    ON stops (stop_code);
CREATE INDEX ix_routes_agency ON routes (agency_id);

CREATE VIRTUAL TABLE stops_rtree USING rtree(stop_ref, min_lat, max_lat, min_lon, max_lon);
CREATE VIRTUAL TABLE stops_fts USING fts5(stop_name, stop_ref UNINDEXED, tokenize='unicode61');
`;

/**
 * A four-stop network in Tel Aviv, close enough together that every pair is
 * within a plausible walking radius:
 *
 *   stop 1 "מרכזית" ──R1──> stop 2 "הרצל" ──R2──> stop 4 (platform of station 3)
 *
 * R1 runs twice on weekdays (service S1); R2 runs once, after midnight
 * (25:30), which is the >86400 case. Station 3 is location_type=1 with stop 4
 * as its child.
 */
export function buildFixtureDb(dir: string, version = VERSION): string {
  const file = `gtfs-${version}.sqlite`;
  const db = new Database(join(dir, file));
  db.pragma("journal_mode = WAL");
  db.exec(DDL);

  db.exec(`
    INSERT INTO agency VALUES ('2','רכבת ישראל','http://www.rail.co.il','Asia/Jerusalem','he','5770','');

    INSERT INTO routes VALUES ('R1','2','1','קו ראשון','67001-1-#',3,'FF0000');
    INSERT INTO routes VALUES ('R2','2','2','קו שני','67002-1-#',3,NULL);
    -- Line 67003: one public line, four route rows. Directions 1 and 3 both
    -- carry GTFS direction_id 0, which is why
    -- a line's directions are keyed on the desc digit and never on
    -- direction_id. Direction 1 has two alternatives, R3 (3 stops) and R4
    -- (2 stops, a short working) -- getLine must pick R3.
    INSERT INTO routes VALUES ('R3','2','3','קו שלישי','67003-1-0',3,NULL);
    INSERT INTO routes VALUES ('R4','2','3','קו שלישי מקוצר','67003-1-א',3,NULL);
    INSERT INTO routes VALUES ('R5','2','3','קו שלישי חזור','67003-2-0',3,NULL);
    INSERT INTO routes VALUES ('R6','2','3','קו שלישי חלופי','67003-3-0',3,NULL);
    -- Rail: no line code (no dash), and an empty short_name, so it is named
    -- by its long name and is a line of one.
    --
    -- R7 and R8 SHARE the bare desc '900' while being different services,
    -- which is the real feed's behaviour: 32 undashed descs there are
    -- carried by exactly two route rows each. A rail line is therefore
    -- keyed on its ROUTE ID, not on this desc -- keying on the desc would
    -- merge these two into one line and make whichever of them has fewer
    -- stops disappear behind the other.
    INSERT INTO routes VALUES ('R7','2','','נהריה<->מודיעין','900',2,NULL);
    INSERT INTO routes VALUES ('R8','2','','מודיעין<->נהריה','900',2,NULL);

    INSERT INTO stops VALUES (1,'1000','38831','מרכזית','רחוב: לוינסקי 108',32.0554,34.7800,0,NULL,'z1');
    INSERT INTO stops VALUES (2,'2000','38832','הרצל','רחוב: הרצל',32.0600,34.7750,0,NULL,'z1');
    INSERT INTO stops VALUES (3,'3000',NULL,'תחנת השלום',NULL,32.0700,34.7900,1,NULL,'z1');
    INSERT INTO stops VALUES (4,'4000','38834','תחנת השלום/רציף 1',NULL,32.0701,34.7901,0,'3000','z1');

    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon FROM stops;
    INSERT INTO stops_fts (stop_name, stop_ref) SELECT stop_name, stop_ref FROM stops;

    -- Sunday-first, matching the feed's column order. S1 = Sun-Thu, S2 = Fri-Sat.
    INSERT INTO calendar VALUES ('S1',1,1,1,1,1,0,0,20260821,20260920);
    INSERT INTO calendar VALUES ('S2',0,0,0,0,0,1,1,20260821,20260920);

    INSERT INTO trips VALUES (1,'T1','R1','S1','הרצל',0,'SH1',1);
    INSERT INTO trips VALUES (2,'T2','R1','S1','הרצל',0,'SH1',1);
    INSERT INTO trips VALUES (3,'T3','R2','S1','תחנת השלום',0,NULL,0);
    -- direction_id 0 for R3/R4/R6 and 1 for R5, matching the desc digits
    -- 1/1/3 and 2 respectively. Numbered from 101 rather than 4: several
    -- suites extend this fixture with trips of their own and take the next
    -- free low trip_ref/trip_id (4, 5, ...), so leaving that range alone
    -- keeps the shared fixture free to grow.
    INSERT INTO trips VALUES (101,'T101','R3','S1','תחנת השלום',0,NULL,0);
    INSERT INTO trips VALUES (102,'T102','R4','S1','הרצל',0,NULL,0);
    INSERT INTO trips VALUES (103,'T103','R5','S1','מרכזית',1,NULL,0);
    INSERT INTO trips VALUES (104,'T104','R6','S1','תחנת השלום',0,NULL,0);
    -- Rail trip_headsigns are TRAIN NUMBERS, as in the real feed -- never a
    -- destination. The API shows the trip's last stop instead (see
    -- db/tripHeadsign.ts) and returns the number as tripNumber.
    INSERT INTO trips VALUES (105,'T105','R7','S1','105',0,NULL,0);
    INSERT INTO trips VALUES (106,'T106','R8','S1','106',1,NULL,0);

    -- T1 08:00 -> 08:10, T2 09:00 -> 09:10 (same pattern, no overtaking).
    -- Every trip's terminal stop_times row below carries pickup_type=1:
    -- boarding is not possible at a trip's final stop, only alighting
    -- (drop_off_type stays 0), so this holds for T1, T2, and T3 alike.
    INSERT INTO stop_times VALUES (1,1,1,28800,28800,0,1,0);
    -- T1's final stop.
    INSERT INTO stop_times VALUES (1,2,2,29400,29400,1,0,1200);
    INSERT INTO stop_times VALUES (2,1,1,32400,32400,0,1,0);
    -- T2's final stop.
    INSERT INTO stop_times VALUES (2,2,2,33000,33000,1,0,1200);
    -- T3 departs 25:30 (91800) — past midnight, the >86400 case.
    INSERT INTO stop_times VALUES (3,2,1,91800,91800,0,1,0);
    -- T3's final stop.
    INSERT INTO stop_times VALUES (3,4,2,92400,92400,1,0,900);
    -- Early afternoon (12:00 onwards), clear of the 07:00-11:00 morning the
    -- other suites plan and board over on this same handful of stops.
    -- T101 (R3, direction 1): three stops, the longest run on this direction.
    INSERT INTO stop_times VALUES (101,1,1,43200,43200,0,1,0);
    INSERT INTO stop_times VALUES (101,2,2,43800,43800,0,0,1200);
    INSERT INTO stop_times VALUES (101,4,3,44400,44400,1,0,2400);
    -- T102 (R4, direction 1): two stops, the short working getLine must reject.
    INSERT INTO stop_times VALUES (102,1,1,46800,46800,0,1,0);
    INSERT INTO stop_times VALUES (102,2,2,47400,47400,1,0,1200);
    -- T103 (R5, direction 2): the return leg.
    INSERT INTO stop_times VALUES (103,4,1,50400,50400,0,1,0);
    INSERT INTO stop_times VALUES (103,1,2,51600,51600,1,0,2400);
    -- T104 (R6, direction 3): direction_id 0, same as direction 1 above.
    -- Its final stop deliberately carries a NULL shape_dist_traveled: about
    -- 13,169 of the real feed's 14.8M stop_times rows do, and TimetableIndex
    -- represents that as -1 (distance 0 is a legitimate value and cannot
    -- double as the sentinel). predictFromDistance in match.ts must decline
    -- to place a vehicle on a trip whose distances are incomplete.
    INSERT INTO stop_times VALUES (104,2,1,54000,54000,0,1,0);
    INSERT INTO stop_times VALUES (104,4,2,54600,54600,1,0,NULL);
    -- T105 (R7, rail).
    INSERT INTO stop_times VALUES (105,1,1,57600,57600,0,1,0);
    INSERT INTO stop_times VALUES (105,4,2,59400,59400,1,0,3600);
    -- T106 (R8, rail): the other service sharing desc '900', running the
    -- other way at 17:00 -- still clear of the 07:00-11:00 morning every
    -- other suite plans over.
    INSERT INTO stop_times VALUES (106,4,1,61200,61200,0,1,0);
    INSERT INTO stop_times VALUES (106,1,2,63000,63000,1,0,3600);

    -- Encodes the R1 stop pair (32.0554,34.7800) -> (32.0600,34.7750) at this
    -- codebase's precision-6 default, so shape geometry actually lands near
    -- Tel Aviv rather than the classic Google polyline-algorithm sample
    -- (which decodes to California regardless of precision).
    INSERT INTO shapes VALUES ('SH1','oeoc|@_uxiaAo~GnwH',2,1200.0);

    INSERT INTO translations VALUES ('הרצל','EN','Herzl');
    INSERT INTO translations VALUES ('הרצל','AR','هرتسل');
    INSERT INTO translations VALUES ('הרצל','HE','הרצל');
    INSERT INTO translations VALUES ('מרכזית','EN','Central Station');
    -- Note: no translation for 'תחנת השלום' — exercises the Hebrew fallback.
  `);

  db.prepare("INSERT INTO feed_meta VALUES (?, ?)").run("version", version);
  db.prepare("INSERT INTO feed_meta VALUES (?, ?)").run("fetched_at", "2026-08-21T16:11:13.189Z");
  db.prepare("INSERT INTO feed_meta VALUES (?, ?)").run(
    "counts", JSON.stringify({ agency: 1, routes: 8, stops: 4, calendar: 2, trips: 9, stop_times: 19 }),
  );
  db.close();

  const link = join(dir, "gtfs.sqlite");
  symlinkSync(file, link);
  return link;
}
