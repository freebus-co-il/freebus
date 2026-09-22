import unzipper from "unzipper";
import { pipeline } from "node:stream";
import type { Readable } from "node:stream";

export interface ZipEntry {
  readonly name: string;
  readonly uncompressedSize: number;
  /** Read this entry's decompressed bytes. Call exactly one of stream/skip. */
  stream(): Readable;
  /** Discard this entry so iteration can advance. */
  skip(): void;
}

// @types/unzipper declares `vars` without `uncompressedSize`, but unzipper's
// parser always resolves the true size onto `entry.vars.uncompressedSize` —
// directly from the local header, or (for Zip64 entries whose header carries
// the 0xffffffff sentinel) by folding in the Zip64 extra field. That fold-in
// happens in-place before the entry is ever handed to us, so `vars` is the
// one property that is correct regardless of whether a given entry needed
// the Zip64 extra field. `extra.uncompressedSize` is not a substitute: it is
// only populated for entries that actually carried a Zip64 extra field, and
// is undefined otherwise.
type EntryVars = unzipper.Entry["vars"] & { uncompressedSize: number };

/**
 * Yields archive entries in stream order. The MOT archive is Zip64 with sizes
 * in local headers (no data descriptors), so forward-only reading is safe.
 *
 * Entries arrive alphabetically, which places stop_times.txt before stops.txt
 * and trips.txt — loading therefore runs with foreign_keys off, and
 * finalize.ts's orphan gate checks referential integrity afterward.
 *
 * Callers must call exactly one of `stream()` or `skip()` per entry before
 * advancing to the next iteration. This reader is forward-only: an entry that
 * is neither consumed nor drained blocks the underlying stream forever, and
 * with it the whole iterator — there is no error, just a stall.
 *
 * `pipeline`, not `src.pipe(...)`. `Readable.prototype.pipe` forwards data
 * and `end` but NOT errors, and only in one direction: a *source* that errors
 * emits on itself, where — with nobody having attached an `error` listener
 * anywhere along this chain — Node turns it into an uncaught exception and
 * kills the process. That is not hypothetical; a socket dying mid-download
 * (ECONNRESET on a 139 MB transfer) did exactly that, taking the process out
 * before importFeed's catch could run and leaving an orphaned build database
 * on disk. `pipeline` destroys the destination with the source's error, so
 * the `for await` below rejects and the failure travels the ordinary path.
 *
 * The callback is required (without one `pipeline` throws) and deliberately
 * empty: it fires for the same error the `for await` is about to reject with,
 * and handling it twice would only produce a duplicate report. Its presence
 * is what keeps that error "handled" in the window before the consumer sees
 * it.
 */
export async function* zipEntries(src: Readable): AsyncIterable<ZipEntry> {
  const parsed = unzipper.Parse({ forceStream: true });
  pipeline(src, parsed, () => {});
  for await (const entry of parsed) {
    const e = entry as unzipper.Entry;
    const vars = e.vars as EntryVars;
    yield {
      name: e.path,
      uncompressedSize: vars.uncompressedSize,
      stream: () => e as Readable,
      skip: () => void e.autodrain(),
    };
  }
}
