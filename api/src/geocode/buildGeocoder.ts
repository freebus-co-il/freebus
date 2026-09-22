import type { GeocoderConfig } from "../config.js";
import { CompositeGeocoder } from "./composite.js";
import { GoogleGeocoder } from "./google.js";
import { PhotonClient } from "./photon.js";
import type { Geocoder } from "./types.js";

/**
 * The geocoder `GEOCODER` names. Validation (unknown backend, missing key)
 * already happened at boot, in `resolveGeocoderConfig`.
 *
 * `GEOCODER` chooses who answers address SEARCH. It does NOT choose who
 * answers reverse: that is always Photon, because Google's Geocoding API bills
 * $5 per 1,000 and its extra quality buys nothing when the answer only has to
 * name the street a rider is standing on. See `CompositeGeocoder`.
 *
 * Takes its config as an argument rather than reading the module-level
 * `geocoderConfig`, so both branches can be tested in one process --
 * `config.ts` captures the environment at module load, which a test cannot
 * undo. `server.ts` passes the real one.
 */
export function buildGeocoder(
  cfg: GeocoderConfig,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Geocoder {
  const photon = new PhotonClient(cfg.photon);
  if (cfg.google === null) {
    log.info("geocoding: photon for search and reverse");
    return photon;
  }
  log.info("geocoding: google for search, photon for reverse");
  return new CompositeGeocoder(new GoogleGeocoder({ ...cfg.google, warn: log.warn }), photon);
}
