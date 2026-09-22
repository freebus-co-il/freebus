/** Returned instead of a value when the deadline wins the race. A symbol
 *  rather than `null` so it can never collide with something the awaited
 *  promise might legitimately resolve to. */
export const TIMED_OUT = Symbol('timed-out');

/**
 * The promise, or `TIMED_OUT` if it takes longer than `ms`.
 *
 * A rejection still rejects -- a provider that fails outright is a different
 * answer from one that never answers, and the caller may want to tell them
 * apart. The pending timer is cleared as soon as the promise wins, so this
 * never keeps a process (or a test run) alive waiting on a deadline that no
 * longer matters.
 *
 * Nothing cancels the underlying promise, because nothing can: it keeps
 * running and its late result is simply dropped. That is the point -- once
 * the caller has been told the answer never came, a straggler must not be
 * able to reach back and contradict it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
