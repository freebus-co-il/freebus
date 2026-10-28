/**
 * Rewrites the deep links that are not routes.
 *
 * Two of them reach this app. A `geo:` URI is a location the rider tapped in
 * another app and carries its position in the URL itself, so it goes straight
 * to the share screen as text. The share extension's own
 * `freebus://dataUrl=...` carries nothing usable: it only signals that a
 * payload is waiting in the native module for `share-intent-gate` to read, so
 * it simply opens the app. Neither matches a file in `src/app`, and without
 * this both would land the rider on "unmatched route".
 */
export function redirectSharePath(path: string): string {
  if (path.includes('dataUrl=')) return '/';

  // The leading slash depends on how the link was handed over, and this must
  // not turn on that detail.
  const withoutLeadingSlash = path.replace(/^\/+/, '');
  if (/^geo:/i.test(withoutLeadingSlash)) {
    return `/share?text=${encodeURIComponent(withoutLeadingSlash)}`;
  }

  return path;
}
