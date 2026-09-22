import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { csvRows } from "./csv.js";

const feed = (body: string): Readable =>
  Readable.from([Buffer.from("﻿" + body.replace(/\n/g, "\r\n"), "utf8")]);

async function collect(src: Readable): Promise<Record<string, string>[]> {
  const out: Record<string, string>[] = [];
  for await (const row of csvRows(src)) out.push(row);
  return out;
}

test("strips the BOM from the first header", async () => {
  const rows = await collect(feed("stop_id,stop_name\n1,Foo\n"));
  assert.deepEqual(Object.keys(rows[0]!), ["stop_id", "stop_name"]);
});

test("keys rows by header name regardless of column order", async () => {
  const rows = await collect(
    feed("route_id,service_id,trip_id\nR1,S1,T1\n"),
  );
  assert.equal(rows[0]!.trip_id, "T1");
  assert.equal(rows[0]!.route_id, "R1");
});

test("fixture: Hebrew stop name from real feed (regression)", async () => {
  // This test pins real-feed content containing Hebrew text with embedded
  // gershayim (double ASCII apostrophes ''). It is not a test of quote-character
  // handling; csv-parse defaults to " as the quote character, so ' is never special
  // here. The test exercises columns: true and real-world text roundtrip only.
  const rows = await collect(
    feed("stop_id,stop_name\n1,בי''ס בר לב/בן יהודה\n"),
  );
  assert.equal(rows[0]!.stop_name, "בי''ס בר לב/בן יהודה");
});

test("tolerates a literal double-quote inside an unquoted field (real feed)", async () => {
  // Found against the real translations.txt: Hebrew gershayim is sometimes
  // rendered as a literal ASCII '"' rather than the '' pair the fixture
  // covers (see the other Hebrew test above). csv-parse's default
  // (relax_quotes: false) throws INVALID_OPENING_QUOTE on this — it treats
  // the '"' as a misplaced opening quote rather than a literal character.
  // This aborted the entire first live import at translations.txt line 312.
  const rows = await collect(
    feed('trans_id,lang,translation\n784/שדרות קק"ל,HE,784/שדרות קק"ל\n'),
  );
  assert.equal(rows[0]!.trans_id, '784/שדרות קק"ל');
  assert.equal(rows[0]!.translation, '784/שדרות קק"ל');
});

test("honours quoted fields containing commas", async () => {
  const rows = await collect(feed('stop_id,stop_desc\n1,"a,b"\n'));
  assert.equal(rows[0]!.stop_desc, "a,b");
});

test("skips trailing blank lines", async () => {
  const rows = await collect(feed("stop_id\n1\n\n"));
  assert.equal(rows.length, 1);
});

test("tolerates ragged rows with extra fields", async () => {
  // Without relax_column_count, extra fields throw and abort parsing.
  // With relax_column_count: true, they are silently dropped and parsing continues.
  const rows = await collect(
    feed("stop_id,stop_name\n1,Foo,extra1,extra2\n2,Bar\n"),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.stop_id, "1");
  assert.equal(rows[0]!.stop_name, "Foo");
  assert.equal(Object.keys(rows[0]!).length, 2);
});

test("tolerates ragged rows with missing fields", async () => {
  // Without relax_column_count, missing fields throw and abort parsing.
  // With relax_column_count: true, they are left as undefined and parsing continues.
  const rows = await collect(
    feed("stop_id,stop_name,stop_desc\n1,Foo\n2,Bar,Baz\n"),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.stop_id, "1");
  assert.equal(rows[0]!.stop_name, "Foo");
  assert.equal(rows[0]!.stop_desc, undefined);
});

/**
 * The source direction of the same seam zip.ts had. csv-parse's own errors
 * (an unterminated quote, say) travel the *destination* side and were always
 * catchable — that is the path importFeed's existing mid-stream test
 * exercises. An error on the entry stream feeding the parser is the other
 * direction, and `pipe` never forwarded it: it emitted on a listener-less
 * stream and killed the process. Revert csv.ts to `src.pipe(parse(...))` and
 * this test fails with an uncaught exception instead of a rejection.
 */
test("forwards a source-stream error to the consumer instead of emitting it unhandled", async () => {
  let sent = false;
  const src = new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(Buffer.from("stop_id,stop_name\r\n1,Foo\r\n"));
      setImmediate(() => this.destroy(new Error("entry stream failed")));
    },
  });

  await assert.rejects(collect(src), /entry stream failed/);
});
