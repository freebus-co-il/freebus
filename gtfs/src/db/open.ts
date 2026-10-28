import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export type { Database };

/**
 * Opens a disposable build database.
 *
 * Durability pragmas are disabled deliberately: this file is thrown away if the
 * run fails, and the live database is never touched until the swap. Foreign
 * keys are off because stop_times.txt arrives before stops.txt and trips.txt.
 */
export function openBuildDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = OFF");
  db.pragma("cache_size = -262144"); // ~256 MB
  db.exec(SCHEMA_SQL);
  return db;
}

export function openReadDb(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}
