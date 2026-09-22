import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { buildFixtureZip } from "../testing/fixture.js";
import { fetchFeed } from "./client.js";

const ZIP_TYPE = "application/x-zip-compressed";

function response(body: Buffer, init: ResponseInit): Response {
  return new Response(body, init);
}

test("returns unchanged on 304", async () => {
  const fetchImpl = async () => new Response(null, { status: 304 });
  const r = await fetchFeed("https://x/f.zip", { etag: '"e1"', lastModified: null }, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(r.status, "unchanged");
});

test("sends conditional headers when a previous version is known", async () => {
  let seen: Headers | undefined;
  const fetchImpl = async (_u: unknown, init: RequestInit) => {
    seen = new Headers(init.headers);
    return new Response(null, { status: 304 });
  };
  await fetchFeed("https://x/f.zip", { etag: '"e1"', lastModified: "Thu, 20 Aug 2026 16:31:37 GMT" }, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(seen!.get("if-none-match"), '"e1"');
  assert.equal(seen!.get("if-modified-since"), "Thu, 20 Aug 2026 16:31:37 GMT");
});

test("returns a readable body and version on 200", async () => {
  const buf = await buildFixtureZip();
  const fetchImpl = async () =>
    response(buf, {
      status: 200,
      headers: { "content-type": ZIP_TYPE, etag: '"e2"' },
    });
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.version.etag, '"e2"');
  const chunks: Buffer[] = [];
  for await (const c of r.body) chunks.push(c as Buffer);
  assert.ok(Buffer.concat(chunks).subarray(0, 4).equals(Buffer.from("PK\x03\x04")));
});

test("rejects an unexpected HTML response instead of parsing it as a zip", async () => {
  const fetchImpl = async () =>
    response(Buffer.from("<html>Access Denied</html>"), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  await assert.rejects(
    fetchFeed("https://x/f.zip", null, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    /content-type/i,
  );
});

test("rejects a zip content-type whose body lacks the PK magic", async () => {
  const fetchImpl = async () =>
    response(Buffer.from("not a zip at all"), {
      status: 200,
      headers: { "content-type": ZIP_TYPE },
    });
  await assert.rejects(
    fetchFeed("https://x/f.zip", null, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    /magic/i,
  );
});

test("retries on 5xx then succeeds", async () => {
  const buf = await buildFixtureZip();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) return new Response("busy", { status: 503 });
    return response(buf, { status: 200, headers: { "content-type": ZIP_TYPE } });
  };
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retries: 3,
  });
  assert.equal(r.status, "ok");
  assert.equal(calls, 3);
});

test("gives up after exhausting retries", async () => {
  const fetchImpl = async () => new Response("busy", { status: 503 });
  await assert.rejects(
    fetchFeed("https://x/f.zip", null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 2,
    }),
    /503/,
  );
});

/**
 * A Response whose body is a stream deliberately left open (not closed) so
 * that calling `.cancel()` on it is an unambiguous, observable release —
 * not a no-op on an already-finished stream.
 */
function cancellableResponse(
  body: Uint8Array,
  init: ResponseInit,
): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream, init), wasCancelled: () => cancelled };
}

test("releases the response body of a 5xx response before retrying", async () => {
  const wasCancelledFns: Array<() => boolean> = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) {
      const { response: res, wasCancelled } = cancellableResponse(
        Buffer.from("busy"),
        { status: 503 },
      );
      wasCancelledFns.push(wasCancelled);
      return res;
    }
    const buf = await buildFixtureZip();
    return response(buf, { status: 200, headers: { "content-type": ZIP_TYPE } });
  };
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retries: 3,
  });
  assert.equal(r.status, "ok");
  assert.equal(wasCancelledFns.length, 2);
  assert.ok(
    wasCancelledFns.every((wasCancelled) => wasCancelled()),
    "each abandoned 5xx response body must be released before the next attempt, not left open holding a socket",
  );
});

test("releases the response body of a non-retryable error response", async () => {
  const { response: res404, wasCancelled } = cancellableResponse(
    Buffer.from("nope"),
    { status: 404 },
  );
  const fetchImpl = async () => res404;
  await assert.rejects(
    fetchFeed("https://x/f.zip", null, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    /404/,
  );
  assert.ok(wasCancelled(), "a rejected non-retryable response body must be released, not left dangling");
});

test("releases the response body when content-type is rejected", async () => {
  const { response: htmlRes, wasCancelled } = cancellableResponse(
    Buffer.from("<html>Access Denied</html>"),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
  const fetchImpl = async () => htmlRes;
  await assert.rejects(
    fetchFeed("https://x/f.zip", null, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    /content-type/i,
  );
  assert.ok(wasCancelled(), "a rejected HTML-response body must be released, not left dangling");
});

test("guarded stream is byte-identical when the first chunk is larger than the magic", async () => {
  const buf = await buildFixtureZip();
  // Split so the first chunk is well past the 4-byte magic length: guardMagic's
  // `head` accumulates one whole chunk that is larger than it strictly needs,
  // which is exactly the boundary case that would corrupt output if the
  // implementation replayed only `prefix.subarray(0, 4)` instead of the whole
  // accumulated head.
  const firstChunkSize = 37;
  const first = buf.subarray(0, firstChunkSize);
  const rest = buf.subarray(firstChunkSize);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(first));
      controller.enqueue(new Uint8Array(rest));
      controller.close();
    },
  });
  const fetchImpl = async () =>
    new Response(stream, { status: 200, headers: { "content-type": ZIP_TYPE } });
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const chunks: Buffer[] = [];
  for await (const c of r.body) chunks.push(c as Buffer);
  assert.ok(
    Buffer.concat(chunks).equals(buf),
    "guarded output must be byte-identical to the source archive across a chunk boundary well past the magic",
  );
});

test("does not send conditional headers on a first run with no previous version", async () => {
  let seen: Headers | undefined;
  const buf = await buildFixtureZip();
  const fetchImpl = async (_u: unknown, init: RequestInit) => {
    seen = new Headers(init.headers);
    return response(buf, { status: 200, headers: { "content-type": ZIP_TYPE } });
  };
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(r.status, "ok");
  assert.equal(
    seen!.has("if-none-match"),
    false,
    "a cold start must never send If-None-Match — a stray value could draw a 304 and the service would silently never build a database",
  );
  assert.equal(
    seen!.has("if-modified-since"),
    false,
    "a cold start must never send If-Modified-Since — a stray value could draw a 304 and the service would silently never build a database",
  );
});

// --- Stall timeout ---------------------------------------------------------
//
// A stall timeout aborts a stream that stops producing bytes for longer than
// the configured window. Without it, a half-open connection could wedge the
// import — and with it the single-flight lock — permanently, while /health
// kept answering 200.

/** A response body that emits `head`, then goes silent forever. */
function stallingBody(head: Buffer): Response {
  return new Response(
    new ReadableStream({ start(c) { c.enqueue(head); } }),
    { status: 200, headers: { "content-type": ZIP_TYPE } },
  );
}

test("aborts a body that stops producing bytes for longer than the stall timeout", async () => {
  const zip = await buildFixtureZip();
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl: (async () => stallingBody(zip.subarray(0, 512))) as unknown as typeof fetch,
    stallTimeoutMs: 150,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;

  await assert.rejects(
    async () => {
      for await (const _ of r.body) { /* drain until the watchdog fires */ }
    },
    /stalled: no bytes received for 150ms/,
  );
});

test("the stall timeout is an idle timer, not a total-duration cap", async () => {
  // A slow but progressing stream must never be aborted: the real import
  // takes ~53 s end to end and a deliberately generous ceiling would be
  // worthless if it also capped healthy transfers. Chunks here arrive every
  // 40 ms with a 150 ms idle timeout, for a total well over the timeout.
  const zip = await buildFixtureZip();
  const chunkSize = Math.ceil(zip.length / 8);
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        async start(c) {
          for (let i = 0; i < zip.length; i += chunkSize) {
            await new Promise((res) => setTimeout(res, 40));
            c.enqueue(zip.subarray(i, i + chunkSize));
          }
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": ZIP_TYPE } },
    )) as unknown as typeof fetch;

  const started = Date.now();
  const r = await fetchFeed("https://x/f.zip", null, {
    fetchImpl, stallTimeoutMs: 150,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;

  const chunks: Buffer[] = [];
  for await (const chunk of r.body) chunks.push(chunk as Buffer);
  assert.deepEqual(Buffer.concat(chunks), zip);
  assert.ok(
    Date.now() - started > 150,
    "the transfer must have outlasted the idle timeout without being aborted",
  );
});

test("a stalled body aborts the request signal, releasing the socket", async () => {
  // Racing the read is what makes the *stream* fail; aborting is what frees
  // the real connection. An injected fetchImpl's body is not wired to the
  // signal, so only the abort is observable here — but it is the half that
  // matters against a live socket, and it would be easy to drop.
  const zip = await buildFixtureZip();
  let signal: AbortSignal | undefined;
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return stallingBody(zip.subarray(0, 512));
  }) as unknown as typeof fetch;

  const r = await fetchFeed("https://x/f.zip", null, { fetchImpl, stallTimeoutMs: 100 });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.ok(signal, "fetchFeed must pass an AbortSignal so a stall can free the socket");
  assert.equal(signal.aborted, false);

  await assert.rejects(async () => {
    for await (const _ of r.body) { /* drain */ }
  });
  assert.equal(signal.aborted, true, "the stall must abort the in-flight request");
});
