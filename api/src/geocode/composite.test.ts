import { test } from "node:test";
import assert from "node:assert/strict";

import { CompositeGeocoder } from "./composite.js";
import type { GeocodePlace, Geocoder, LatLon, SearchOptions } from "./types.js";
import type { Lang } from "../db/i18n.js";

/**
 * A `Geocoder` that answers with its own name and records what it was asked.
 *
 * Real HTTP stubs (the style `google.test.ts` and `photon.test.ts` use) would
 * prove nothing extra here: the only claim worth making about this class is
 * WHICH backend each operation reaches, and a spy states that directly.
 */
function spy(name: string): Geocoder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async search(q: string, lang: Lang, limit: number, opts?: SearchOptions): Promise<GeocodePlace[]> {
      calls.push(`search:${q}:${lang}:${limit}:${opts?.session ?? "-"}`);
      return [{
        label: name, secondaryLabel: null, lat: null, lon: null, placeId: name, distanceMeters: null,
      }];
    },
    async place(placeId: string, session?: string): Promise<LatLon | null> {
      calls.push(`place:${placeId}:${session ?? "-"}`);
      return { lat: 1, lon: 2 };
    },
    async reverse(lat: number, lon: number, lang: Lang): Promise<GeocodePlace | null> {
      calls.push(`reverse:${lat}:${lon}:${lang}`);
      return {
        label: name, secondaryLabel: null, lat, lon, placeId: null, distanceMeters: null,
      };
    },
  };
}

test("search goes to the search backend, and nowhere else", async () => {
  const search = spy("google");
  const reverse = spy("photon");
  const geocoder = new CompositeGeocoder(search, reverse);

  const results = await geocoder.search("dizengoff", "en", 5, { session: "s1" });

  assert.equal(results[0]!.label, "google");
  assert.deepEqual(search.calls, ["search:dizengoff:en:5:s1"]);
  assert.deepEqual(reverse.calls, [], "the reverse backend must not be touched by a search");
});

test("place goes to the search backend -- it resolves that backend's own id", async () => {
  // A `placeId` only means anything to the backend that issued it, so `place`
  // has to follow `search`. Sending it to Photon would be a lookup of a Google
  // id against an index that has never seen one.
  const search = spy("google");
  const reverse = spy("photon");
  const geocoder = new CompositeGeocoder(search, reverse);

  const at = await geocoder.place("ChIJxxxx", "s1");

  assert.deepEqual(at, { lat: 1, lon: 2 });
  assert.deepEqual(search.calls, ["place:ChIJxxxx:s1"]);
  assert.deepEqual(reverse.calls, []);
});

test("reverse goes to the reverse backend, and nowhere else", async () => {
  // The whole point: turning coordinates into a label must never reach the
  // metered backend.
  const search = spy("google");
  const reverse = spy("photon");
  const geocoder = new CompositeGeocoder(search, reverse);

  const place = await geocoder.reverse(32.0731, 34.7925, "he");

  assert.equal(place!.label, "photon");
  assert.deepEqual(reverse.calls, ["reverse:32.0731:34.7925:he"]);
  assert.deepEqual(search.calls, [], "reverse must never bill the search backend");
});

test("a reverse backend that finds nothing returns null rather than falling back", async () => {
  // No silent fallback to the metered backend: an outage must degrade to "no
  // label", not to a bill. `location-picker`/`share` already handle null.
  const search = spy("google");
  const reverse: Geocoder = {
    search: async () => [],
    place: async () => null,
    reverse: async () => null,
  };
  const geocoder = new CompositeGeocoder(search, reverse);

  assert.equal(await geocoder.reverse(32.0731, 34.7925, "en"), null);
  assert.deepEqual(search.calls, []);
});
