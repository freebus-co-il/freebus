import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGeocoder } from "./buildGeocoder.js";
import { CompositeGeocoder } from "./composite.js";
import { GoogleGeocoder } from "./google.js";
import { PhotonClient } from "./photon.js";
import type { GeocoderConfig } from "../config.js";

const silent = { info: () => {}, warn: () => {} };

const photonOnly: GeocoderConfig = {
  backend: "photon",
  photon: { url: "http://photon:2322", timeoutMs: 5_000 },
  google: null,
};

const withGoogle: GeocoderConfig = {
  backend: "google",
  photon: { url: "http://photon:2322", timeoutMs: 5_000 },
  google: { apiKey: "k", timeoutMs: 3_000, dailyRequestLimit: 3_000 },
};

test("GEOCODER=photon answers everything from Photon", () => {
  const geocoder = buildGeocoder(photonOnly, silent);
  assert.ok(geocoder instanceof PhotonClient, "one backend for all three needs no wrapper");
});

test("GEOCODER=google still sends reverse to Photon, not to Google", () => {
  // Google's Geocoding API bills $5 per 1,000 for a lookup whose answer only
  // has to be a street name, so reverse must stay on Photon regardless.
  const geocoder = buildGeocoder(withGoogle, silent);
  assert.ok(geocoder instanceof CompositeGeocoder);

  const { forSearch, forReverse } = geocoder as unknown as {
    forSearch: unknown; forReverse: unknown;
  };
  assert.ok(forSearch instanceof GoogleGeocoder, "search must reach Google -- OSM misses businesses");
  assert.ok(forReverse instanceof PhotonClient, "reverse must reach Photon -- it is free");
});

test("the log says which backend answers what", () => {
  // The one line in the boot log that tells an operator, without reading
  // code, that a metered API is or is not in the reverse path.
  const lines: string[] = [];
  buildGeocoder(withGoogle, { info: (m) => lines.push(m), warn: () => {} });
  assert.match(lines.join(" "), /google.*search.*photon.*reverse/i);

  lines.length = 0;
  buildGeocoder(photonOnly, { info: (m) => lines.push(m), warn: () => {} });
  assert.match(lines.join(" "), /photon/i);
  assert.doesNotMatch(lines.join(" "), /google/i);
});
