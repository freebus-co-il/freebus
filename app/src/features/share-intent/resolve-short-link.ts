import { TIMED_OUT, withTimeout } from '@/lib/with-timeout';

import { isMapShortenerUrl, parseSharedText, type SharedTarget } from './parse-shared-place';

/** Only what this needs from `fetch`: where the redirect chain ended up.
 *  Narrow enough that a test can stand in for the network with one line. */
type FetchLike = (url: string) => Promise<{ url: string }>;

/** Long enough for a redirect on a weak mobile connection, short enough that
 *  the rider is told it failed rather than left watching a spinner. */
const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Expands a shortened map link into the position it points at.
 *
 * The whole method is one request and one parse: `fetch` follows redirects
 * itself, so the expanded URL arrives as `response.url` and goes straight
 * back through the parser. Nothing about the response body is read, which is
 * what keeps this cheap and independent of how Google renders its map today.
 *
 * Every failure -- an unknown host, no signal, a redirect into a consent page
 * with no coordinates in it -- returns `null`. The caller has a fallback for
 * "could not read this", and no failure here deserves to crash a share.
 */
export async function resolveShortLink(
  url: string,
  fetchImpl: FetchLike = fetch,
  options: { timeoutMs?: number } = {},
): Promise<Extract<SharedTarget, { kind: 'coordinate' }> | null> {
  // Following a link means requesting a URL that arrived in a message from
  // someone else. Only the shorteners the parser recognises are ever fetched.
  if (!isMapShortenerUrl(url)) return null;

  try {
    const response = await withTimeout(fetchImpl(url), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (response === TIMED_OUT) return null;

    const parsed = parseSharedText(response.url);
    return parsed?.kind === 'coordinate' ? parsed : null;
  } catch {
    return null;
  }
}
