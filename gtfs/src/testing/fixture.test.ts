import { test } from "node:test";
import assert from "node:assert/strict";
import unzipper from "unzipper";
import { Readable } from "node:stream";
import { buildFixtureZip, FIXTURE_FILES } from "./fixture.js";

test("fixture archive round-trips with BOM and CRLF preserved", async () => {
  const buf = await buildFixtureZip();
  const dir = await unzipper.Open.buffer(buf);
  const names = dir.files.map((f) => f.path);

  assert.deepEqual(names, [...names].sort(), "entries must be alphabetical");
  assert.ok(names.includes("stop_times.txt"));
  assert.ok(
    names.indexOf("stop_times.txt") < names.indexOf("stops.txt"),
    "stop_times must precede stops, as in the real feed",
  );

  const agency = dir.files.find((f) => f.path === "agency.txt")!;
  const text = (await agency.buffer()).toString("utf8");
  assert.ok(text.startsWith("﻿"), "entry must carry a UTF-8 BOM");
  assert.ok(text.includes("\r\n"), "entry must use CRLF endings");
});

test("fixture streams as a forward-only zip", async () => {
  const buf = await buildFixtureZip();
  const seen: string[] = [];
  const zip = Readable.from(buf).pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of zip) {
    seen.push(entry.path);
    entry.autodrain();
  }
  assert.deepEqual(seen, Object.keys(FIXTURE_FILES).sort());
});
