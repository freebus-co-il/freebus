import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { DailyBudget, GoogleGeocoder } from "./google.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

/** Same shape as `photon.test.ts`'s `withStub`, but records method, headers
 *  and JSON body too -- what gets SENT is most of what keeps Google cheap. */
async function withStub(
  handler: (seen: Seen) => { status?: number; json: unknown },
  body: (url: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const s: Seen = {
        method: req.method ?? "", url: req.url ?? "", headers: req.headers,
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      seen.push(s);
      const out = handler(s);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function client(url: string, overrides: { dailyRequestLimit?: number; warn?: (m: string) => void } = {}) {
  return new GoogleGeocoder({
    apiKey: "test-key",
    timeoutMs: 1000,
    dailyRequestLimit: overrides.dailyRequestLimit ?? 0,
    warn: overrides.warn ?? (() => {}),
    placesBaseUrl: url,
    geocodingBaseUrl: url,
  });
}

function prediction(placeId: string, main: string, secondary?: string, distanceMeters?: number) {
  return {
    placePrediction: {
      placeId,
      structuredFormat: {
        mainText: { text: main },
        ...(secondary !== undefined ? { secondaryText: { text: secondary } } : {}),
      },
      ...(distanceMeters !== undefined ? { distanceMeters } : {}),
    },
  };
}

test("search maps predictions to placeId results with no coordinates", async () => {
  await withStub(() => ({
    json: { suggestions: [prediction("abc", "Azrieli Center", "Menachem Begin Rd, Tel Aviv-Yafo, Israel")] },
  }), async (url) => {
    const places = await client(url).search("azrieli", "en", 8);
    assert.deepEqual(places, [{
      label: "Azrieli Center",
      secondaryLabel: "Menachem Begin Rd, Tel Aviv-Yafo",
      lat: null, lon: null, placeId: "abc", distanceMeters: null,
    }]);
  });
});

test("search strips the Hebrew country suffix too", async () => {
  await withStub(() => ({
    json: { suggestions: [prediction("abc", "עזריאלי", "תל אביב-יפו, ישראל")] },
  }), async (url) => {
    const [place] = await client(url).search("עזריאלי", "he", 8);
    assert.equal(place!.secondaryLabel, "תל אביב-יפו");
  });
});

test("search sends the key, a narrow field mask, the session and an Israel restriction", async () => {
  await withStub(() => ({ json: { suggestions: [] } }), async (url, seen) => {
    await client(url).search("x", "he", 8, { session: "sess-1" });
    const req = seen[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/places:autocomplete");
    assert.equal(req.headers["x-goog-api-key"], "test-key");
    assert.match(String(req.headers["x-goog-fieldmask"]), /^suggestions\.placePrediction\./);
    const body = req.body as Record<string, unknown>;
    assert.equal(body["sessionToken"], "sess-1");
    assert.equal(body["languageCode"], "he");
    assert.deepEqual(body["includedRegionCodes"], ["il", "ps"]);
    assert.ok("rectangle" in (body["locationBias"] as object));
    assert.equal(body["origin"], undefined);
  });
});

test("search biases around `near` and reports the distance Google measured", async () => {
  await withStub(() => ({
    json: { suggestions: [prediction("abc", "Cafe", "Haifa", 412)] },
  }), async (url, seen) => {
    const [place] = await client(url).search("cafe", "en", 8, { near: { lat: 32.8, lon: 34.99 } });
    const body = seen[0]!.body as Record<string, any>;
    assert.deepEqual(body["locationBias"].circle.center, { latitude: 32.8, longitude: 34.99 });
    assert.deepEqual(body["origin"], { latitude: 32.8, longitude: 34.99 });
    assert.equal(place!.distanceMeters, 412);
  });
});

test("search skips query predictions and caps at limit", async () => {
  await withStub(() => ({
    json: { suggestions: [
      { queryPrediction: { text: { text: "pizza near me" } } },
      prediction("a", "A"), prediction("b", "B"), prediction("c", "C"),
    ] },
  }), async (url) => {
    const places = await client(url).search("x", "en", 2);
    assert.deepEqual(places.map((p) => p.placeId), ["a", "b"]);
  });
});

test("search degrades to [] and logs Google's own error on a failure", async () => {
  const warnings: string[] = [];
  await withStub(() => ({ status: 403, json: { error: { message: "API key not valid" } } }), async (url) => {
    const places = await client(url, { warn: (m) => warnings.push(m) }).search("x", "en", 8);
    assert.deepEqual(places, []);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /403.*API key not valid/);
});

test("place asks for location only, with the session, and returns the position", async () => {
  await withStub(() => ({ json: { location: { latitude: 32.07, longitude: 34.79 } } }), async (url, seen) => {
    const location = await client(url).place("ChIJ_abc-1", "sess-1");
    assert.deepEqual(location, { lat: 32.07, lon: 34.79 });
    assert.equal(seen[0]!.url, "/v1/places/ChIJ_abc-1?sessionToken=sess-1");
    // `location` alone is the Essentials SKU; `displayName` would be Pro.
    assert.equal(seen[0]!.headers["x-goog-fieldmask"], "location");
  });
});

test("place returns null for a response with no location", async () => {
  await withStub(() => ({ json: {} }), async (url) => {
    assert.equal(await client(url).place("abc"), null);
  });
});

test("reverse builds street + number with the city as subtitle", async () => {
  await withStub(() => ({
    json: {
      status: "OK",
      results: [
        { types: ["plus_code"], formatted_address: "XXXX+XX", address_components: [] },
        {
          types: ["street_address"],
          formatted_address: "Herzl St 1, Tel Aviv-Yafo, Israel",
          geometry: { location: { lat: 32.0801, lng: 34.7802 } },
          address_components: [
            { long_name: "1", types: ["street_number"] },
            { long_name: "Herzl St", types: ["route"] },
            { long_name: "Tel Aviv-Yafo", types: ["locality", "political"] },
          ],
        },
      ],
    },
  }), async (url, seen) => {
    const place = await client(url).reverse(32.08, 34.78, "en");
    assert.deepEqual(place, {
      label: "Herzl St 1", secondaryLabel: "Tel Aviv-Yafo",
      lat: 32.0801, lon: 34.7802, placeId: null, distanceMeters: null,
    });
    assert.match(seen[0]!.url, /^\/maps\/api\/geocode\/json\?latlng=32\.08%2C34\.78&language=en&key=test-key$/);
  });
});

test("reverse returns null on ZERO_RESULTS without logging", async () => {
  const warnings: string[] = [];
  await withStub(() => ({ json: { status: "ZERO_RESULTS", results: [] } }), async (url) => {
    assert.equal(await client(url, { warn: (m) => warnings.push(m) }).reverse(0, 0, "he"), null);
  });
  assert.deepEqual(warnings, []);
});

test("reverse logs a denied status, which Google sends as HTTP 200", async () => {
  const warnings: string[] = [];
  await withStub(() => ({ json: { status: "REQUEST_DENIED", error_message: "not authorized" } }), async (url) => {
    assert.equal(await client(url, { warn: (m) => warnings.push(m) }).reverse(0, 0, "he"), null);
  });
  assert.match(warnings[0]!, /REQUEST_DENIED: not authorized/);
});

test("past the daily limit nothing reaches Google and the limit is logged once", async () => {
  const warnings: string[] = [];
  await withStub(() => ({ json: { suggestions: [prediction("a", "A")] } }), async (url, seen) => {
    const google = client(url, { dailyRequestLimit: 2, warn: (m) => warnings.push(m) });
    assert.equal((await google.search("x", "he", 8)).length, 1);
    assert.equal((await google.search("y", "he", 8)).length, 1);
    assert.deepEqual(await google.search("z", "he", 8), []);
    assert.equal(await google.place("a"), null);
    assert.equal(seen.length, 2);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /daily request limit \(2\)/);
});

test("the daily budget resets on a new UTC day, and 0 means unlimited", () => {
  let now = new Date("2026-09-13T23:59:00Z");
  const budget = new DailyBudget(1, () => {}, () => now);
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  now = new Date("2026-09-14T00:00:01Z");
  assert.equal(budget.take(), true);

  const unlimited = new DailyBudget(0, () => { throw new Error("never exhausted"); });
  for (let i = 0; i < 100; i++) assert.equal(unlimited.take(), true);
});
