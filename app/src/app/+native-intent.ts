import { redirectSharePath } from '@/features/share-intent/redirect-system-path';

/** Thin shell over `redirectSharePath`, which holds the actual rules -- this
 *  file is a route, and routes are the one place in the app that tests cannot
 *  reach. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return redirectSharePath(path);
}
