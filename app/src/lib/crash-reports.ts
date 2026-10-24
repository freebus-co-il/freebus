import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';

import { scrubEvent } from './crash-scrub';

/**
 * Crash reports for JavaScript errors, sent to Sentry, and nothing more.
 *
 * Kept to what finds a bug, and stripped of anything about the rider (see
 * `crash-scrub.ts` for what a report may carry):
 *
 * - JavaScript errors only. Native crash, app hang, watchdog and ANR
 *   handling are off: those reports are produced by the native SDKs, which
 *   our `beforeSend` never sees, and they attach a persistent installation
 *   id. Native crashes still reach us through App Store Connect and Play
 *   Console, from riders who opted in there.
 * - No breadcrumbs. They would record every request URL, and this app's
 *   URLs carry coordinates, stop ids and search text.
 * - No sessions (release health), tracing, profiling, replay, screenshots,
 *   view hierarchy or failed-request capture.
 * - `sendDefaultPii: false`, which also tells Sentry never to infer the IP
 *   address from the request.
 *
 * Off unless all of these hold: a release build (`__DEV__` builds send
 * nothing), a native platform (no web), and `EXPO_PUBLIC_SENTRY_DSN` set,
 * which only the EAS `production` environment does, so preview builds and
 * forks of this repo report nowhere.
 *
 * `@sentry/react-native` is NATIVE: adding or upgrading it needs a store
 * build, and the runtime version (a fingerprint) keeps an update that
 * imports it away from binaries built without it.
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

let started = false;

export function initCrashReports(): void {
  if (started || __DEV__ || Platform.OS === 'web' || !DSN) return;
  started = true;

  try {
    Sentry.init({
      dsn: DSN,
      sendDefaultPii: false,

      enableNativeCrashHandling: false,
      enableAppHangTracking: false,
      enableWatchdogTerminationTracking: false,
      enableNdk: false,

      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,

      enableAutoSessionTracking: false,
      enableAutoPerformanceTracing: false,
      enableCaptureFailedRequests: false,
      attachScreenshot: false,
      attachViewHierarchy: false,

      beforeSend: scrubEvent,
    });
  } catch {
    started = false;
  }
}
