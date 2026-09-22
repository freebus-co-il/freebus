import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFeed } from "./importFeed.js";
import { feedConfig } from "../config.js";

const enabled = process.env.GTFS_LIVE_TEST === "1";

test("imports the real MOT feed", { skip: !enabled, timeout: 900_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtfs-live-"));
  const r = await importFeed({
    url: feedConfig.url, dataDir: dir, now: () => new Date(),
  });
  assert.equal(r.status, "imported");
  if (r.status !== "imported") return;
  assert.ok((r.counts.stop_times ?? 0) > 1_000_000, `stop_times=${r.counts.stop_times}`);
  assert.ok((r.counts.stops ?? 0) > 10_000, `stops=${r.counts.stops}`);
  console.log("counts", r.counts, "duration", r.durationMs, "ms");
});
