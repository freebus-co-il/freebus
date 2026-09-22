import { router, useRootNavigationState } from 'expo-router';
import { useEffect } from 'react';
import { useShareIntentContext } from 'expo-share-intent';

/**
 * Hands a location shared from another app to the share screen.
 *
 * Renders nothing: a share arrives through the native module rather than
 * through a URL, so there is no route for it to land on and something mounted
 * has to notice. Sharing into an app that is already open is the common case
 * -- there is no new deep link then, only a payload appearing -- which is why
 * this watches a value instead of a link.
 *
 * The payload is cleared as it is passed on. Left in place, the module still
 * reports it the next time the app comes back to the foreground, and a share
 * the rider dealt with an hour ago would reopen itself.
 */
export function ShareIntentGate() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  // `router` throws if it is used before the navigator has mounted, which on a
  // cold start launched BY a share is exactly when this first fires.
  const navigationReady = useRootNavigationState()?.key != null;

  useEffect(() => {
    if (!hasShareIntent || !navigationReady) return;

    // `webUrl` is the link the sender's app extracted; `text` is the raw
    // message it came in. Preferring the link skips the prose around it, and
    // the parser handles either.
    const text = shareIntent.webUrl ?? shareIntent.text;
    resetShareIntent();
    if (!text) return;

    router.push({ pathname: '/share', params: { text } });
    // `resetShareIntent` and `shareIntent` are rebuilt on every render of the
    // provider; keying on them would re-run this after the payload is already
    // cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent, navigationReady]);

  return null;
}
