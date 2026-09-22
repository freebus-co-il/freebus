import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { buildFixtureZip } from "../testing/fixture.js";
import { csvRows } from "./csv.js";
import { zipEntries } from "./zip.js";

test("iterates entries in archive order", async () => {
  const buf = await buildFixtureZip();
  const names: string[] = [];
  for await (const entry of zipEntries(Readable.from(buf))) {
    names.push(entry.name);
    entry.skip();
  }
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.indexOf("stop_times.txt") < names.indexOf("stops.txt"));
});

test("reports uncompressed size and streams entry content", async () => {
  const buf = await buildFixtureZip();
  let rows = 0;
  let size = 0;
  for await (const entry of zipEntries(Readable.from(buf))) {
    if (entry.name === "stop_times.txt") {
      size = entry.uncompressedSize;
      for await (const _ of csvRows(entry.stream())) rows++;
    } else {
      entry.skip();
    }
  }
  assert.equal(rows, 3);
  assert.ok(size > 0);
});

test("rejects input that is not a zip archive", async () => {
  const html = Readable.from(Buffer.from("<html>blocked</html>"));
  await assert.rejects(async () => {
    for await (const entry of zipEntries(html)) entry.skip();
  });
});

/**
 * Hand-builds a single-entry zip whose LOCAL file header carries the genuine
 * Zip64 sentinel structure the real MOT archive uses: both sizes set to
 * 0xFFFFFFFF in the 32-bit header fields, with the true 64-bit sizes carried
 * in a trailing Zip64 extra field (header id 0x0001). `buildFixtureZip`
 * cannot exercise this path — `yazl`'s `forceZip64Format` only
 * forces Zip64 structure into the CENTRAL DIRECTORY, and this streaming
 * reader never looks at the central directory; its local headers always
 * carry true sizes with a zero-length extra field. Compression is "stored"
 * (method 0) so the payload passes through untouched, and stream()'s content
 * check pins the compressed-size sentinel resolution too (both sizes are
 * read from the same Zip64 extra field, in the same fold-in step).
 */
function buildZip64SentinelZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");

  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0); // Zip64 extended info header id
  extra.writeUInt16LE(16, 2); // data size: 8-byte uncompressed + 8-byte compressed
  extra.writeBigUInt64LE(BigInt(data.length), 4); // true uncompressed size
  extra.writeBigUInt64LE(BigInt(data.length), 12); // true compressed size (stored)

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(45, 4); // version needed to extract (Zip64)
  header.writeUInt16LE(0, 6); // flags: no data descriptor
  header.writeUInt16LE(0, 8); // compression method: stored
  header.writeUInt16LE(0, 10); // last mod time
  header.writeUInt16LE(0, 12); // last mod date
  header.writeUInt32LE(0, 14); // crc32 (unchecked by this reader)
  header.writeUInt32LE(0xffffffff, 18); // compressed size: Zip64 sentinel
  header.writeUInt32LE(0xffffffff, 22); // uncompressed size: Zip64 sentinel
  header.writeUInt16LE(nameBuf.length, 26); // file name length
  header.writeUInt16LE(extra.length, 28); // extra field length

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(0, 8); // record count on this disk
  eocd.writeUInt16LE(0, 10); // total record count
  eocd.writeUInt32LE(0, 12); // size of central directory
  eocd.writeUInt32LE(0, 14); // offset to start of central directory
  eocd.writeUInt16LE(0, 18); // comment length

  return Buffer.concat([header, nameBuf, extra, data, eocd]);
}

test("resolves the true size when a local header carries the Zip64 sentinel", async () => {
  const payload = Buffer.from(
    "Zip64 sentinel resolution regression guard payload.\n",
    "utf8",
  );
  const buf = buildZip64SentinelZip("big.txt", payload);

  let size = -1;
  let received: Buffer | undefined;
  for await (const entry of zipEntries(Readable.from(buf))) {
    assert.equal(entry.name, "big.txt");
    size = entry.uncompressedSize;
    const chunks: Buffer[] = [];
    for await (const chunk of entry.stream()) chunks.push(chunk as Buffer);
    received = Buffer.concat(chunks);
  }

  assert.notEqual(size, 0xffffffff, "must not report the raw sentinel");
  assert.equal(size, payload.length);
  assert.deepEqual(received, payload);
});

/**
 * The seam no per-task review owned: client.ts builds the body, zip.ts pipes
 * it, csv.ts pipes again, importFeed owns the try/catch — and
 * `Readable.prototype.pipe` forwards data and `end` but NOT the source's
 * errors. Before the `pipeline` fix a socket dying mid-download emitted
 * `error` on a stream nobody listened to, which Node turns into an uncaught
 * exception: the process died, importFeed's catch never ran, and an orphaned
 * build database (up to 666 MB against the real feed) was left behind.
 *
 * Reverting zip.ts to `src.pipe(unzipper.Parse(...))` makes this test fail —
 * the rejection never arrives and the error surfaces as an uncaught
 * exception instead.
 */
test("forwards a source-stream error to the consumer instead of emitting it unhandled", async () => {
  const buf = await buildFixtureZip();
  let sent = false;
  const src = new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(buf.subarray(0, 512));
      setImmediate(() => {
        const err = new Error("socket hang up") as Error & { code?: string };
        err.code = "ECONNRESET";
        this.destroy(err);
      });
    },
  });

  await assert.rejects(
    async () => {
      for await (const entry of zipEntries(src)) entry.skip();
    },
    /socket hang up/,
  );
});

/**
 * A body that ends mid-entry — the truncated-download case. With `pipeline`
 * (not `src.pipe(...)`, see the note above) the reader reports FILE_ENDED
 * and the iterator rejects rather than stalling.
 */
test("rejects a truncated archive rather than stalling forever", async () => {
  const buf = await buildFixtureZip();
  const truncated = buf.subarray(0, Math.floor(buf.length * 0.6));

  await assert.rejects(
    async () => {
      for await (const entry of zipEntries(Readable.from(truncated))) {
        for await (const _ of entry.stream()) { /* drain */ }
      }
    },
  );
});
