import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { buildServer } from "../server.js";

/**
 * A server with one extra route that raises a REAL better-sqlite3 error, so
 * the leak these tests pin is a genuine one, not a hypothetical:
 *
 *   {"statusCode":500,"code":"SQLITE_ERROR","error":"Internal Server Error",
 *    "message":"no such column: nope"}
 *
 * — driver identity plus a fragment of the internal schema, handed to an
 * anonymous caller of a public API.
 */
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-err-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  const app = await buildServer({ index, adminToken: null });
  app.get("/__boom", async () => {
    // Exactly the shape of failure a schema drift would produce in a real
    // query: better-sqlite3 throws with .code = "SQLITE_ERROR".
    app.db.db.prepare("SELECT nope FROM stops").all();
    return { unreachable: true };
  });
  return { app, index };
}

test("a 500 leaks no SQLite code, no driver message, no stack, and names the request id", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/__boom" });
  assert.equal(res.statusCode, 500);

  const body = res.json() as Record<string, unknown>;
  assert.equal(body["statusCode"], 500);
  assert.equal(body["code"], "internal_error");
  assert.equal(typeof body["requestId"], "string");
  assert.notEqual(body["requestId"], "");

  // The whole point: none of the internals reach the wire.
  assert.doesNotMatch(res.body, /SQLITE/i);
  assert.doesNotMatch(res.body, /no such column/i);
  assert.doesNotMatch(res.body, /\bnope\b/);
  assert.doesNotMatch(res.body, /\bat .*\.ts:/, "no stack frames");

  await app.close(); index.stop();
});

// A 4xx is intentional and its message is the useful part -- suppressing it
// would make every client mistake indistinguishable from every other. So the
// envelope is shared, but the message passes through.
test("a 4xx keeps its own message inside the shared envelope", async () => {
  const { app, index } = await serve();

  const missingParam = await app.inject({ url: "/plan?from=1,2" });
  assert.equal(missingParam.statusCode, 400);
  const a = missingParam.json() as Record<string, unknown>;
  assert.equal(a["statusCode"], 400);
  assert.equal(a["code"], "bad_request");
  assert.match(String(a["message"]), /required property 'to'/);
  assert.equal(typeof a["requestId"], "string");

  const unknownTrip = await app.inject({ url: "/trips/NOPE" });
  assert.equal(unknownTrip.statusCode, 404);
  const b = unknownTrip.json() as Record<string, unknown>;
  assert.equal(b["statusCode"], 404);
  assert.equal(b["code"], "not_found");
  assert.equal(b["message"], "No trip with id NOPE");

  await app.close(); index.stop();
});

// Fastify's built-in 404 does not pass through setErrorHandler, so without
// its own handler it would be the one remaining body in a different shape.
test("an unrouted URL answers in the same envelope as every other error", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/no/such/route" });
  assert.equal(res.statusCode, 404);
  const body = res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "requestId", "statusCode"]);
  assert.equal(body["code"], "not_found");
  await app.close(); index.stop();
});

// One parser, every error: `statusCode`, `code`, `message`, `requestId` are
// present and correctly typed on 4xx, 5xx, sensible-raised, schema-raised
// and ApiError-raised responses alike.
test("every error route in the service answers in one envelope", async () => {
  const { app, index } = await serve();
  const cases: [string, number, string][] = [
    ["/__boom", 500, "internal_error"],
    ["/plan?from=1,2", 400, "bad_request"],
    ["/trips/NOPE", 404, "not_found"],
    ["/stops/NOPE/departures", 404, "not_found"],
    ["/no/such/route", 404, "not_found"],
    // /plan's own machine-readable codes survive the unification.
    ["/plan?from=1,2&to=3,4&departAfter=2020-01-01T00:00:00%2B03:00", 422,
      "date_outside_service_window"],
  ];
  for (const [url, status, code] of cases) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, status, url);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body["statusCode"], status, url);
    assert.equal(body["code"], code, url);
    assert.equal(typeof body["message"], "string", url);
    assert.equal(typeof body["requestId"], "string", url);
  }
  await app.close(); index.stop();
});

// POST /admin/reload with no token configured: the 401 must be the shared
// envelope too, not a fourth shape.
test("the 401 from the admin gate uses the shared envelope", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ method: "POST", url: "/admin/reload" });
  assert.equal(res.statusCode, 401);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body["statusCode"], 401);
  assert.equal(body["code"], "unauthorized");
  assert.equal(res.headers["www-authenticate"], "Bearer");
  await app.close(); index.stop();
});

/**
 * One raw HTTP request, with the path sent EXACTLY as given.
 *
 * `app.inject()` cannot exercise the two cases below: it normalises a
 * malformed URL before Fastify's router ever sees it, so neither pre-router
 * error fires. These have to go over a real socket against a real listening
 * server to reproduce.
 */
function raw(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * PRE-ROUTER framework errors.
 *
 * Fastify raises these before routing happens, so `setErrorHandler` never
 * sees them; without the frameworkErrors hook below, Fastify would answer
 * them with its own body, a three-key shape carrying the internal identifier
 * as the public code:
 *
 *   414 {"error":"Bad Request","code":"FST_ERR_MAX_PARAM_LENGTH", ...}
 *   400 {"error":"Bad Request","code":"FST_ERR_BAD_URL", ...}
 *
 * Nothing sensitive leaks, but two contract claims would be false: that every
 * error uses one envelope, and that `FST_ERR_*` never reaches a client.
 */
test("pre-router framework errors use the shared envelope, keeping their real status", async () => {
  const { app, index } = await serve();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  try {
    const cases: [string, string, number, string][] = [
      // maxParamLength defaults to 100; 101 characters trips it.
      ["max param length", `/trips/${"a".repeat(101)}`, 414, "uri_too_long"],
      // %ZZ is not valid percent-encoding.
      ["bad url", "/trips/%ZZ", 400, "bad_url"],
    ];
    for (const [label, path, status, code] of cases) {
      const res = await raw(port, path);
      assert.equal(res.status, status, label);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      // The SAME four keys as every other error in the service -- no more,
      // no fewer. `error` (Fastify's reason-phrase key) must be gone.
      assert.deepEqual(
        Object.keys(body).sort(), ["code", "message", "requestId", "statusCode"], label,
      );
      assert.equal(body["statusCode"], status, label);
      assert.equal(body["code"], code, label);
      assert.equal(typeof body["message"], "string", label);
      assert.equal(typeof body["requestId"], "string", label);
      assert.notEqual(body["requestId"], "", label);
      // The internal identifier is translated, never passed through.
      assert.doesNotMatch(res.body, /FST_ERR_/, label);
    }
  } finally {
    await app.close();
    index.stop();
  }
});

// The same server, over the same real socket, must answer a well-formed
// request normally -- proving the frameworkErrors hook intercepts only the
// pre-router failures and changes no other path's shape.
test("a well-formed request over a real socket is unaffected by the framework hook", async () => {
  const { app, index } = await serve();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  try {
    const ok = await raw(port, "/health");
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.body) as { status: string }).status, "ok");

    // A routed 404 still goes through setNotFoundHandler, not the framework
    // hook, and still carries the same four keys.
    const missing = await raw(port, "/trips/NOPE");
    assert.equal(missing.status, 404);
    const body = JSON.parse(missing.body) as Record<string, unknown>;
    assert.equal(body["code"], "not_found");
    assert.equal(body["message"], "No trip with id NOPE");
  } finally {
    await app.close();
    index.stop();
  }
});
