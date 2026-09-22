import { parentPort, workerData } from "node:worker_threads";
import { buildIndex } from "./index.js";

// Worker entry point. The 2.53 s build is CPU-bound and synchronous; running
// it on the main thread would add its full duration to the latency of every
// request in flight, which happens on every feed swap.
const { dbPath } = workerData as { dbPath: string };
const index = buildIndex(dbPath);

// Typed arrays are moved rather than copied via the transfer list, so the
// ~84 MB is never duplicated. The string arrays and the Map are
// structured-cloned; that is unavoidable and costs well under a second.
//
// Collected into a Set, not pushed into an array unconditionally: buildIndex
// (via buildPatterns) constructs TripTimes as `.subarray()` views over one
// shared `timeStops`/`arrivalTime`/`departureTime` buffer, so two views CAN
// legitimately share a single underlying ArrayBuffer. Today none of those
// particular views end up on the returned TimetableIndex (patternStops etc.
// are copied out via `.set()` into fresh arrays first), but that is an
// invariant of buildIndex's current implementation, not something the
// TimetableIndex type enforces — a future change that returns a view
// directly instead of copying it would silently reintroduce the hazard.
// Pushing the same ArrayBuffer into postMessage's transfer list twice throws
// a DataCloneError and crashes the worker outright, rather than merely
// duplicating data. A Set costs nothing here and turns that from a latent
// crash into a no-op.
const transfers = new Set<ArrayBuffer>();
for (const value of Object.values(index)) {
  if (ArrayBuffer.isView(value)) transfers.add(value.buffer as ArrayBuffer);
}
parentPort?.postMessage(index, [...transfers]);
