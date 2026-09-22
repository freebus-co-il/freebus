import { useEffect, useState } from 'react';

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * A clock that re-renders its caller on an interval.
 *
 * Exists for the results card's "leave in 4 min" line: a countdown rendered
 * once and never updated is worse than an absolute time, because it keeps
 * looking authoritative while silently going stale. Thirty seconds is fine
 * for a minute-granularity label -- the value can only ever be half a minute
 * behind, which rounds away.
 */
export function useNow(intervalMs: number = DEFAULT_INTERVAL_MS): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
