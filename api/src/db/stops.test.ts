import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { Translator } from "./i18n.js";
import { searchStops, nearbyStops, getStop, siblingStopIds, stopsInBox } from "./stops.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-stops-"));
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  return { h, tr: Translator.load(h.db) };
}

test("searches Hebrew stop names via FTS", () => {
  const { h, tr } = fixture();
  const results = searchStops(h.db, tr, { q: "הרצל", lang: "he", limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.stopId, "2000");
  h.close();
});

// The FTS index holds only Hebrew feed text. Without also searching the
// translations, an English-typing user finds nothing at all.
test("searches English names via translations", () => {
  const { h, tr } = fixture();
  const results = searchStops(h.db, tr, { q: "Herzl", lang: "en", limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.stopId, "2000");
  assert.equal(results[0]!.name, "Herzl");
  h.close();
});

test("search results carry a badge-ready brief per line serving each stop", () => {
  const { h, tr } = fixture();
  const results = searchStops(h.db, tr, { q: "מרכזית", lang: "he", limit: 10 });
  // The operator comes along so a client can colour the badge; the vehicle
  // type so it can draw a glyph for a line with no number of its own.
  assert.deepEqual(results[0]!.routes, [
    { shortName: "1", agencyId: "2", type: 3 },
    // Line 67003's rows (R3 and R4) share short name "3" and collapse to one
    // badge; the rail row R7 has no short name of its own.
    { shortName: "3", agencyId: "2", type: 3 },
  ]);
  h.close();
});

// Rail lines have no number and so no badge: the flag is how a list tells a
// train station from a bus stop.
test("search and nearby results flag the stops trains call at", () => {
  const { h, tr } = fixture();
  const [central] = searchStops(h.db, tr, { q: "מרכזית", lang: "he", limit: 10 });
  const [herzl] = searchStops(h.db, tr, { q: "הרצל", lang: "he", limit: 10 });
  assert.equal(central!.rail, true, "rail R7 calls at stop 1000");
  assert.equal(herzl!.rail, false, "only buses call at stop 2000");
  const near = nearbyStops(h.db, tr, { lat: central!.lat, lon: central!.lon, radiusMeters: 50, limit: 10, lang: "he" });
  assert.equal(near.find((s) => s.stopId === central!.stopId)?.rail, true);
  h.close();
});

test("a query with FTS syntax characters is treated as literal text", () => {
  const { h, tr } = fixture();
  // Must not throw an FTS5 syntax error.
  const results = searchStops(h.db, tr, { q: 'הרצל" OR', lang: "he", limit: 10 });
  assert.ok(Array.isArray(results));
  h.close();
});

// FTS5 reads an embedded NUL as premature string termination inside a
// quoted token, throwing a syntax error even though the token was quoted.
// ftsQuery must strip control characters before quoting so this never
// reaches SQLite.
test("a query with an embedded NUL byte does not throw", () => {
  const { h, tr } = fixture();
  const results = searchStops(h.db, tr, { q: "abc" + String.fromCharCode(0) + "def", lang: "he", limit: 10 });
  assert.ok(Array.isArray(results));
  h.close();
});

test("nearby stops are sorted by true distance and bounded by radius", () => {
  const { h, tr } = fixture();
  const results = nearbyStops(h.db, tr, {
    lat: 32.0554, lon: 34.78, radiusMeters: 800, limit: 10, lang: "he",
  });
  assert.equal(results[0]!.stopId, "1000");
  assert.ok(results[0]!.distanceMeters < 5);
  for (const r of results) assert.ok(r.distanceMeters <= 800);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i]!.distanceMeters >= results[i - 1]!.distanceMeters);
  }
  h.close();
});

test("stop detail resolves a station's children", () => {
  const { h, tr } = fixture();
  const stop = getStop(h.db, tr, "3000", "he");
  assert.ok(stop);
  assert.equal(stop.locationType, 1);
  assert.deepEqual(stop.children.map((c) => c.stopId), ["4000"]);
  h.close();
});

test("stop detail lists the routes serving the stop", () => {
  const { h, tr } = fixture();
  const stop = getStop(h.db, tr, "2000", "he");
  assert.deepEqual(
    stop!.routes.map((r) => r.routeId).sort(),
    ["R1", "R2", "R3", "R4", "R6"],
  );
  h.close();
});

test("getStop returns null for an unknown id", () => {
  const { h, tr } = fixture();
  assert.equal(getStop(h.db, tr, "nope", "he"), null);
  h.close();
});

test("stopsInBox pins boardable stops only, with the rail sign where trains call", () => {
  const { h, tr } = fixture();
  const stops = stopsInBox(h.db, tr, {
    minLat: 32.05, maxLat: 32.08, minLon: 34.77, maxLon: 34.80, limit: 100, lang: "he",
  });
  // 3000 is a parent station: its platform 4000 is the pin, not the station.
  assert.deepEqual(stops.map((s) => s.stopId).sort(), ["1000", "2000", "4000"]);
  assert.equal(stops.find((s) => s.stopId === "1000")?.rail, true);
  assert.equal(stops.find((s) => s.stopId === "2000")?.rail, false);
  h.close();
});

test("stopsInBox leaves out stops outside the box", () => {
  const { h, tr } = fixture();
  const stops = stopsInBox(h.db, tr, {
    minLat: 32.058, maxLat: 32.065, minLon: 34.77, maxLon: 34.78, limit: 100, lang: "he",
  });
  assert.deepEqual(stops.map((s) => s.stopId), ["2000"]);
  h.close();
});

test("siblingStopIds expands a station to its platforms and back", () => {
  const { h } = fixture();
  assert.deepEqual(siblingStopIds(h.db, "3000").sort(), ["3000", "4000"]);
  assert.deepEqual(siblingStopIds(h.db, "4000").sort(), ["3000", "4000"]);
  assert.deepEqual(siblingStopIds(h.db, "1000"), ["1000"]);
  h.close();
});

// The sign a stop shows. Light rail is GTFS tram, Jerusalem's told from Tel
// Aviv's by operator; the Carmelit shares its
// route_type with the cable car and is told apart by operator; the Metronit is
// an ordinary bus in the feed, told apart only by its line codes.
test("search, nearby, map and detail results carry the stop's sign", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-stops-"));
  buildFixtureDb(dir);
  const raw = new Database(join(dir, "gtfs.sqlite"));
  raw.exec(`
    INSERT INTO stops VALUES (5,'5000',NULL,'הנביאים',NULL,32.0650,34.7850,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'6000',NULL,'לב הדר',NULL,32.0660,34.7860,0,NULL,'z1');
    INSERT INTO stops VALUES (7,'7000',NULL,'חליסה',NULL,32.0670,34.7870,0,NULL,'z1');
    INSERT INTO stops VALUES (8,'8000',NULL,'בנייני האומה',NULL,32.0680,34.7880,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon FROM stops WHERE stop_ref >= 5;
    INSERT INTO stops_fts (stop_name, stop_ref) SELECT stop_name, stop_ref FROM stops WHERE stop_ref >= 5;

    -- Light rail and the Metronit both call at bus stop 2000: light rail wins.
    INSERT INTO routes VALUES ('LR1','22','1','הקוממיות-בת ים<->קרית אריה-פתח תקווה','72001-1-#',0,NULL);
    INSERT INTO trips VALUES (201,'T201','LR1','S1','קרית אריה',0,NULL,0);
    INSERT INTO stop_times VALUES (201,2,1,64800,64800,0,1,0);
    -- The Carmelit, alone at 5000.
    INSERT INTO routes VALUES ('CR1','20','1','מרכז הכרמל-חיפה<->עיר תחתית-חיפה','72002-1-#',5,NULL);
    INSERT INTO trips VALUES (202,'T202','CR1','S1','עיר תחתית',0,NULL,0);
    INSERT INTO stop_times VALUES (202,5,1,64800,64800,0,1,0);
    -- Metronit line 1 (code 83001) at 6000, which an ordinary bus serves too.
    INSERT INTO routes VALUES ('MT1','16','1','ת. מרכזית חוף הכרמל-חיפה<->מרכזית הקריות-קרית מוצקין','83001-1-0',3,NULL);
    INSERT INTO trips VALUES (203,'T203','MT1','S1','מרכזית הקריות',0,NULL,0);
    INSERT INTO stop_times VALUES (203,6,1,64800,64800,0,1,0);
    INSERT INTO stop_times VALUES (203,2,2,65400,65400,1,0,900);
    -- An ordinary Superbus line: the operator alone is not the Metronit.
    INSERT INTO routes VALUES ('SB1','16','5','חליסה-חיפה<->הדר-חיפה','67050-1-0',3,NULL);
    INSERT INTO trips VALUES (204,'T204','SB1','S1','הדר',0,NULL,0);
    INSERT INTO stop_times VALUES (204,7,1,64800,64800,0,1,0);
    INSERT INTO stop_times VALUES (204,6,2,65400,65400,1,0,900);
    -- The Jerusalem Light Rail: light rail too, by another operator.
    INSERT INTO routes VALUES ('JLR1','21','1','הדסה עין כרם-ירושלים<->נווה יעקב-ירושלים','72003-1-#',0,NULL);
    INSERT INTO trips VALUES (205,'T205','JLR1','S1','נווה יעקב',0,NULL,0);
    INSERT INTO stop_times VALUES (205,8,1,64800,64800,0,1,0);
  `);
  raw.close();
  const h = openTransitDb(dir);
  const tr = Translator.load(h.db);
  const kindOf = (stops: { stopId: string; stationKind: string }[], stopId: string) =>
    stops.find((s) => s.stopId === stopId)?.stationKind;

  const boxed = stopsInBox(h.db, tr, {
    minLat: 32.05, maxLat: 32.08, minLon: 34.77, maxLon: 34.80, limit: 100, lang: "he",
  });
  assert.equal(kindOf(boxed, "1000"), "train");
  assert.equal(kindOf(boxed, "2000"), "lightRail", "light rail outranks the Metronit and buses");
  assert.equal(kindOf(boxed, "8000"), "jerusalemLightRail");
  assert.equal(kindOf(boxed, "5000"), "carmelit");
  assert.equal(kindOf(boxed, "6000"), "metronit", "the Metronit outranks a bus");
  assert.equal(kindOf(boxed, "7000"), "bus", "Superbus alone is not the Metronit");
  assert.equal(boxed.find((s) => s.stopId === "2000")?.rail, false);

  const [herzl] = searchStops(h.db, tr, { q: "הרצל", lang: "he", limit: 10 });
  assert.equal(herzl!.stationKind, "lightRail");
  const near = nearbyStops(h.db, tr, { lat: 32.0660, lon: 34.7860, radiusMeters: 50, limit: 10, lang: "he" });
  assert.equal(kindOf(near, "6000"), "metronit");
  assert.equal(getStop(h.db, tr, "5000", "he")?.stationKind, "carmelit");
  h.close();
});
