import { parse } from "csv-parse";
import { pipeline } from "node:stream";
import type { Readable } from "node:stream";

/**
 * Streams a GTFS text file as header-keyed records.
 *
 * `bom: true` strips the UTF-8 BOM every file in this feed carries; without it
 * the first column parses as "﻿stop_id". csv-parse handles CRLF natively.
 *
 * `relax_quotes: true` — found against the real feed, not the fixture:
 * `translations.txt` (and others) contain Hebrew gershayim rendered as a
 * literal ASCII `"` inside an otherwise-unquoted field, e.g.
 * `784/שדרות קק"ל`. csv-parse's default (`relax_quotes: false`) treats any
 * `"` appearing mid-field as an opening quote in the wrong place and throws
 * `INVALID_OPENING_QUOTE`, aborting the whole stream. The hand-built fixture
 * only exercised the ASCII-apostrophe gershayim variant (`''`, e.g. `בי''ס`),
 * so this never surfaced until the first live run against real data. With
 * `relax_quotes: true`, a `"` that isn't a legal opening/closing quote is
 * treated as a literal character instead of a parse error.
 *
 * `pipeline`, not `src.pipe(...)`, for the same reason as zip.ts: `pipe`
 * forwards data and `end` but not the *source's* errors, so an entry stream
 * that fails mid-file would emit on a stream with no listener and kill the
 * process instead of rejecting this iterator. Errors thrown by the parser
 * itself (a malformed quote, say) already travelled the destination side and
 * were always catchable — it is the source direction that was not, and it is
 * the only direction the existing mid-stream test did not cover.
 */
export function csvRows(src: Readable): AsyncIterable<Record<string, string>> {
  const parser = parse({
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: false,
  });
  pipeline(src, parser, () => {});
  return parser;
}
