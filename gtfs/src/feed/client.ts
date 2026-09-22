import { Readable } from "node:stream";

export interface FeedVersion {
  etag: string | null;
  lastModified: string | null;
}

export type FeedResult =
  | { status: "unchanged" }
  | { status: "ok"; body: Readable; version: FeedVersion };

export interface FetchFeedOptions {
  fetchImpl?: typeof fetch;
  retries?: number;
  /** Base backoff in ms; doubled per attempt. */
  backoffMs?: number;
  /**
   * Idle timeout in ms. The stream is aborted if it goes this long without
   * producing a byte — see `stallGuarded`. Also bounds the wait for response
   * headers. Defaults to 60s.
   */
  stallTimeoutMs?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/** Thrown when a stream stops producing bytes for longer than the timeout. */
export class FeedStallError extends Error {
  constructor(ms: number) {
    super(`feed stalled: no bytes received for ${ms}ms`);
    this.name = "FeedStallError";
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_TYPES = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];

/** This feed rejects requests that don't send a conventional browser user-agent, so one is set. */
const USER_AGENT = "Mozilla/5.0 (compatible; gtfs-fetcher/1.0)";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Releases a Response's body/socket when we are abandoning it without
 * reading it — a retry, or a throw after we've decided not to consume the
 * body. An unread body can otherwise hold the underlying connection open
 * (fetch/undici do not release it just because the Response is garbage
 * collected). Swallows cancel() errors: a body that already errored or was
 * never opened has nothing left to release.
 */
async function abandonBody(res: Response): Promise<void> {
  if (!res.body) return;
  await res.body.cancel().catch(() => undefined);
}

export async function fetchFeed(
  url: string,
  previous: FeedVersion | null,
  opts: FetchFeedOptions = {},
): Promise<FeedResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    // Identity encoding: the payload is already deflate-compressed.
    "accept-encoding": "identity",
  };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= retries; attempt++) {
    // One controller per attempt. It covers both phases of the request: the
    // wait for response headers (cleared the moment they arrive) and, later,
    // the body's idle watchdog. Aborting is what releases the real socket;
    // the Readable-level guard below is what makes the *stream* fail, and
    // both are needed — see stallGuarded.
    const controller = new AbortController();
    let res: Response;
    const headerTimer = setTimeout(
      () => controller.abort(new FeedStallError(stallTimeoutMs)),
      stallTimeoutMs,
    );
    try {
      res = await doFetch(url, {
        headers, redirect: "follow", signal: controller.signal,
      });
    } catch (cause) {
      lastError = new Error(`network error fetching ${url}`, { cause });
      if (attempt < retries) await sleep(backoffMs * 2 ** (attempt - 1));
      continue;
    } finally {
      clearTimeout(headerTimer);
    }

    if (res.status === 304) return { status: "unchanged" };

    if (res.status >= 500) {
      lastError = new Error(`upstream returned ${res.status}`);
      await abandonBody(res);
      if (attempt < retries) await sleep(backoffMs * 2 ** (attempt - 1));
      continue;
    }

    if (!res.ok) {
      await abandonBody(res);
      throw new Error(`upstream returned ${res.status}`);
    }

    // A rejected request gets back an HTML page, not an error status, so
    // both the declared type and the actual bytes are verified before parsing.
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ZIP_TYPES.some((t) => contentType.startsWith(t))) {
      await abandonBody(res);
      throw new Error(
        `unexpected content-type "${contentType}" — expected a zip archive`,
      );
    }
    if (!res.body) throw new Error("upstream returned an empty body");

    const body = await guardMagic(
      Readable.fromWeb(res.body as never),
      stallTimeoutMs,
      () => controller.abort(new FeedStallError(stallTimeoutMs)),
    );

    return {
      status: "ok",
      body,
      version: {
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
      },
    };
  }

  throw lastError ?? new Error(`failed to fetch ${url}`);
}

/**
 * Wraps an async iterator's `next()` in an idle watchdog.
 *
 * A stall timeout aborts a stream that stops producing bytes; this is that
 * timeout. The timer is armed per read and
 * cleared as soon as a chunk (or end-of-stream) arrives, so it measures
 * *idleness*, never total duration — a slow but progressing download never
 * trips it however long the whole transfer takes.
 *
 * Racing at the iterator is deliberate rather than relying on
 * `AbortSignal` alone. Aborting the controller is what frees the real
 * socket, but it only fails the stream when the body is actually wired to
 * that controller; an injected `fetchImpl` (every test here, and any future
 * caller that builds its own Response) hands back a body the signal cannot
 * reach, and the abort would be a no-op while the read stayed pending
 * forever. Racing the read fails the stream unconditionally, and `onStall`
 * releases the socket underneath it.
 *
 * The abandoned `next()` promise gets its own no-op rejection handler: once
 * the race is lost it has no `await`er, and a socket erroring a moment later
 * would otherwise surface as an unhandled rejection attributed to nothing.
 */
function stallGuarded(
  iterator: AsyncIterator<unknown>,
  ms: number,
  onStall: () => void,
): () => Promise<IteratorResult<unknown>> {
  return async () => {
    const next = iterator.next();
    next.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        next,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onStall();
            reject(new FeedStallError(ms));
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Buffers only the first four bytes to assert the zip magic number, then
 * replays them ahead of the rest of the stream. Nothing is held in memory
 * beyond the header.
 *
 * Every byte of the body passes through this one iterator, which makes it the
 * single place the stall watchdog has to be attached.
 */
async function guardMagic(
  src: Readable,
  stallTimeoutMs: number,
  onStall: () => void,
): Promise<Readable> {
  const iterator = src[Symbol.asyncIterator]();
  const next = stallGuarded(iterator, stallTimeoutMs, () => {
    onStall();
    src.destroy();
  });
  const head: Buffer[] = [];
  let headLength = 0;

  while (headLength < ZIP_MAGIC.length) {
    const { value, done } = await next();
    if (done) break;
    const chunk = value as Buffer;
    head.push(chunk);
    headLength += chunk.length;
  }

  const prefix = Buffer.concat(head);
  if (!prefix.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    src.destroy();
    throw new Error(
      "response did not begin with the PK zip magic number — refusing to parse",
    );
  }

  return replayStream(prefix, next, src);
}

/**
 * The stream handed to callers: `prefix` first, then the rest of `src`.
 *
 * Written as an explicit Readable rather than `Readable.from(generator)`,
 * for one reason: **destroy has to reach the socket**. `Readable.from` can
 * only unwind a generator that is suspended at a `yield`; ours spends its
 * life parked on `await next()`, and a read that never settles — the exact
 * case a caller destroys the stream to escape — leaves `destroy()` waiting
 * forever. No `close`, no teardown, and the underlying connection stays
 * open for the life of the process, because fetch/undici do not release an
 * abandoned body on garbage collection. With `_destroy` wired directly,
 * destroying this stream destroys `src`, which cancels the web
 * ReadableStream, which frees the connection — no matter what the read loop
 * is doing at the time.
 */
function replayStream(
  prefix: Buffer,
  next: () => Promise<IteratorResult<unknown>>,
  src: Readable,
): Readable {
  let head: Buffer | null = prefix;
  let reading = false;

  return new Readable({
    read() {
      if (reading) return; // a read is already in flight; push() will resume us
      if (head) {
        const chunk = head;
        head = null;
        this.push(chunk);
        return;
      }
      reading = true;
      next().then(
        ({ value, done }) => {
          reading = false;
          this.push(done ? null : (value as Buffer));
        },
        (err: unknown) => {
          reading = false;
          // Includes FeedStallError. Surfacing it as a stream error is what
          // lets zip.ts's pipeline forward it to the consumer.
          this.destroy(err as Error);
        },
      );
    },
    destroy(err, callback) {
      src.destroy();
      callback(err);
    },
  });
}
