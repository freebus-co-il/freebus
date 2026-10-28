import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PhotonClient } from "./photon.js";

/** Spins up a throwaway HTTP server answering every GET with `handler`'s
 *  return value, mirroring `walking/valhalla.test.ts`'s `withStub` -- closes
 *  the server whether or not `body` throws, so a failing assertion never
 *  leaks a listening socket into the rest of the suite. */
async function withStub(
  handler: (url: string) => unknown,
  body: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function feature(properties: Record<string, unknown>, coordinates: [number, number]) {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates } };
}

test("search maps a street+housenumber feature to a label, city as secondary", async () => {
  await withStub(() => ({
    features: [feature({ street: "Shomer", housenumber: "13", city: "Pardes Hana" }, [34.98, 32.47])],
  }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const places = await client.search("Shomer 13", "he", 8);
    assert.equal(places.length, 1);
    assert.equal(places[0]!.label, "Shomer 13");
    assert.equal(places[0]!.secondaryLabel, "Pardes Hana");
    assert.equal(places[0]!.lat, 32.47);
    assert.equal(places[0]!.lon, 34.98);
  });
});

test("search falls back to name when there is no street", async () => {
  await withStub(() => ({
    features: [feature({ name: "Central Park", city: "Tel Aviv" }, [34.78, 32.08])],
  }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const places = await client.search("Central Park", "he", 8);
    assert.equal(places[0]!.label, "Central Park");
    assert.equal(places[0]!.secondaryLabel, "Tel Aviv");
  });
});

test("search omits a city that duplicates the primary name", async () => {
  await withStub(() => ({
    features: [feature({ name: "Haifa", city: "Haifa" }, [34.99, 32.79])],
  }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const places = await client.search("Haifa", "he", 8);
    assert.equal(places[0]!.label, "Haifa");
    assert.equal(places[0]!.secondaryLabel, null);
  });
});

// Searching "Midtown Tel Aviv" matches a feature genuinely named "Midtown
// TLV Residences" sitting on a real street address. Showing only the street
// address here would look like an unrelated result with no visible
// connection to what was typed, so the name must win as the primary label.
test("search shows a building's name as primary, its address as secondary", async () => {
  await withStub(() => ({
    features: [feature(
      { name: "Midtown TLV Residences", street: "Menachem Begin", housenumber: "144D", city: "Tel Aviv" },
      [34.7936, 32.0779],
    )],
  }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const places = await client.search("Midtown Tel Aviv", "en", 8);
    assert.equal(places[0]!.label, "Midtown TLV Residences");
    assert.equal(places[0]!.secondaryLabel, "Menachem Begin 144D, Tel Aviv");
  });
});

test("search maps he and ar to Photon's default language", async () => {
  let seenUrl = "";
  await withStub((url) => { seenUrl = url; return { features: [] }; }, async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    await client.search("x", "ar", 8);
  });
  assert.ok(seenUrl.includes("lang=default"), seenUrl);
});

test("search maps en to Photon's en language", async () => {
  let seenUrl = "";
  await withStub((url) => { seenUrl = url; return { features: [] }; }, async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    await client.search("x", "en", 8);
  });
  assert.ok(seenUrl.includes("lang=en"), seenUrl);
});

test("search returns an empty array when Photon is unreachable", async () => {
  const client = new PhotonClient({ url: "http://127.0.0.1:1", timeoutMs: 200 });
  const places = await client.search("x", "he", 8);
  assert.deepEqual(places, []);
});

test("search returns an empty array for a response with no features array", async () => {
  await withStub(() => ({ garbage: true }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const places = await client.search("x", "he", 8);
    assert.deepEqual(places, []);
  });
});

test("search skips a feature with non-finite coordinates", async () => {
  await withStub(() => ({
    features: [
      { type: "Feature", properties: { name: "Bad" }, geometry: { type: "Point", coordinates: ["nope", 32] } },
      feature({ name: "Good" }, [34.78, 32.08]),
    ],
  }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const places = await client.search("x", "he", 8);
    assert.equal(places.length, 1);
    assert.equal(places[0]!.label, "Good");
    assert.equal(places[0]!.secondaryLabel, null);
  });
});

test("search passes a near point to Photon's location bias", async () => {
  let seenUrl = "";
  await withStub((url) => { seenUrl = url; return { features: [] }; }, async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    await client.search("x", "he", 8, { near: { lat: 32.1, lon: 34.8 } });
  });
  assert.ok(seenUrl.includes("lat=32.1") && seenUrl.includes("lon=34.8"), seenUrl);
});

test("search results carry their position and no placeId", async () => {
  await withStub(() => ({ features: [feature({ name: "Good" }, [34.78, 32.08])] }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const [place] = await client.search("x", "he", 8);
    assert.equal(place!.placeId, null);
    assert.equal(place!.distanceMeters, null);
  });
});

test("reverse returns the first feature", async () => {
  await withStub(() => ({
    features: [feature({ street: "Herzl", housenumber: "1", city: "Tel Aviv" }, [34.78, 32.08])],
  }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const place = await client.reverse(32.08, 34.78, "he");
    assert.equal(place?.label, "Herzl 1");
    assert.equal(place?.secondaryLabel, "Tel Aviv");
  });
});

test("reverse returns null when there are no features", async () => {
  await withStub(() => ({ features: [] }), async (url) => {
    const client = new PhotonClient({ url, timeoutMs: 1000 });
    const place = await client.reverse(32.08, 34.78, "he");
    assert.equal(place, null);
  });
});

test("reverse returns null when Photon is unreachable", async () => {
  const client = new PhotonClient({ url: "http://127.0.0.1:1", timeoutMs: 200 });
  const place = await client.reverse(32.08, 34.78, "he");
  assert.equal(place, null);
});
