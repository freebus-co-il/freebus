export const SCHEMA_SQL = `
CREATE TABLE agency (
  agency_id        TEXT PRIMARY KEY,
  agency_name      TEXT,
  agency_url       TEXT,
  agency_timezone  TEXT,
  agency_lang      TEXT,
  agency_phone     TEXT,
  agency_fare_url  TEXT
);

CREATE TABLE routes (
  route_id          TEXT PRIMARY KEY,
  agency_id         TEXT,
  route_short_name  TEXT,
  route_long_name   TEXT,
  route_desc        TEXT,
  route_type        INTEGER,
  route_color       TEXT
);

-- stop_ref is the interned surrogate key used by stop_times.
CREATE TABLE stops (
  stop_ref        INTEGER PRIMARY KEY,
  stop_id         TEXT NOT NULL UNIQUE,
  stop_code       TEXT,
  stop_name       TEXT,
  stop_desc       TEXT,
  stop_lat        REAL,
  stop_lon        REAL,
  location_type   INTEGER,
  parent_station  TEXT,
  zone_id         TEXT
);

-- Sunday-first, matching the feed's own column order.
CREATE TABLE calendar (
  service_id  TEXT PRIMARY KEY,
  sunday      INTEGER,
  monday      INTEGER,
  tuesday     INTEGER,
  wednesday   INTEGER,
  thursday    INTEGER,
  friday      INTEGER,
  saturday    INTEGER,
  start_date  INTEGER,
  end_date    INTEGER
);

CREATE TABLE trips (
  trip_ref               INTEGER PRIMARY KEY,
  trip_id                TEXT NOT NULL UNIQUE,
  route_id               TEXT,
  service_id             TEXT,
  trip_headsign          TEXT,
  direction_id           INTEGER,
  shape_id               TEXT,     -- nullable: many trips carry no shape
  wheelchair_accessible  INTEGER
);

-- No declared primary key: rows do not arrive in key order and btree
-- maintenance across ~10.4M inserts is the dominant cost. Uniqueness of
-- (trip_ref, stop_sequence) is asserted by the sanity gates instead.
CREATE TABLE stop_times (
  trip_ref             INTEGER NOT NULL,
  stop_ref             INTEGER NOT NULL,
  stop_sequence        INTEGER NOT NULL,
  arrival_time         INTEGER,
  departure_time       INTEGER,
  pickup_type          INTEGER,
  drop_off_type        INTEGER,
  shape_dist_traveled  REAL
);

-- One row per shape; points are a precision-6 encoded polyline.
CREATE TABLE shapes (
  shape_id          TEXT PRIMARY KEY,
  encoded_polyline  TEXT NOT NULL,
  point_count       INTEGER NOT NULL,
  total_length_m    REAL NOT NULL
);

-- Legacy three-column format: joins on literal text, not on a record id.
CREATE TABLE translations (
  trans_id     TEXT NOT NULL,
  lang         TEXT NOT NULL,
  translation  TEXT,
  PRIMARY KEY (trans_id, lang)
);

CREATE TABLE feed_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
`;
